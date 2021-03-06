const { MongoClient, ObjectID } = require( 'mongodb' )
const tv4 = require( 'tv4' )
const fs = require( 'fs' )
const path = require( 'path' )
const baseItem = require( './baseItem' )

/**
 * An error with a suggested http status error code
 */
const DBError = ( code, message, errors ) => (
    {
        statusCode: code,
        body: {
            errors: errors ? ( Array.isArray( errors ) ? errors : [ errors ] ).map( e => e.message ? e : { message: e } ) : []
        },
        statusMessage: message
    }
)

const findSchemas = ( schemaDir ) => {
    if( !schemaDir ) return []
    let fullPath = path.resolve( schemaDir )
    return fs.readdirSync( fullPath, { withFileTypes: true } )
             .filter( f => !f.isDirectory() )
             .filter( f => f.name.endsWith( '.js' ) || f.name.endsWith( '.json' ) )
             .reduce( ( i, f ) => {
                 let name = f.name.split( '.js' )[ 0 ]
                 return i.concat( { collection: name, schema: baseItem( name, require( path.join( fullPath, f.name ) ) ) } )
             }, [] )
}

const toggleDelete = ( isDelete, mongoCollection ) => ( _id ) => new Promise( ( resolve, reject ) => {
    _id = stringToObjectId( _id )
    if( !_id ) {
        throw DBError( 400, '_id required', 'you must supply an _id to delete' )
    }

    let op = { $set: { _isDeleted: isDelete, _deletedDate: isDelete ? new Date().getTime() : null } }
    mongoCollection.updateOne( { _id: _id }, op, ( err, r ) => {
        if( err ) {
            reject( err )
        } else {
            r.modifiedCount === 1 ? resolve() : reject( DBError( 404, `${schemaName} not found`, `${schemaName} not found` ) )
        }
    } )
} )

const stringToObjectId = ( id ) => id && typeof id === 'string' ? new ObjectID( id ) : id
const objectIdToString = ( id ) => id && id.toString() || id
const _idToObjectId = ( obj ) => {
    if( obj && obj._id ) {
        obj._id = stringToObjectId( obj._id )
    }
    return obj
}

const _idToString = ( obj ) => {
    if( obj && obj._id ) {
        obj._id = objectIdToString( obj._id )
    }
    return obj
}

const dbCollection = ( schemaName, validate, mongoCollection ) => ( {
    save: ( newDoc, allowUpdateToDeletedRecord = false ) => new Promise( ( resolve, reject ) => {
        let validation = validate( newDoc )
        _idToObjectId( newDoc )
        let isNew = !newDoc._id
        if( isNew ) {
            newDoc._id = new ObjectID
            newDoc._created = new Date().getTime()
            newDoc._updated = null
            newDoc._isDeleted = false
        } else {
            newDoc._updated = new Date().getTime()
        }

        if( !validation.valid ) {
            throw DBError( 400, 'Request body is invalid', validation.errors.map( e => ( {
                message: e.message,
                prop: e.dataPath.substr( 1 ).replace( '/', '.' )
            } ) ) )
        }

        if( isNew ) {
            mongoCollection.insertOne( newDoc, ( err, res ) => {
                if( err ) reject( err )
                else {
                    if( res.insertedCount === 1 )
                        resolve( _idToString( newDoc ) )
                    else
                        reject( 'failed to insert' )
                }
            } )
        } else {
            let query = { _id: typeof newDoc._id === 'string' ? new ObjectID( newDoc._id ) : newDoc._id }
            if( !allowUpdateToDeletedRecord ) {
                query._isDeleted = false
            }
            let update = { ...newDoc }
            delete update._created
            delete update._id
            mongoCollection.updateOne( query, { $set: update }, ( err, res ) => {
                if( err ) {
                    reject( err )
                } else {
                    res.upsertedCount === 1 || res.modifiedCount ? resolve( _idToString( newDoc ) ) : reject( DBError( 404, `${schemaName} not found`, `${schemaName} not found` ) )
                }
            } )
        }
    } ),
    find: ( page, pageSize, query = {}, includeDeleted = false ) => new Promise( ( resolve, reject ) => {
        let limit = pageSize && parseInt( pageSize ) || 10
        let skip = ( page && parseInt( page ) || 0 ) * limit
        if( !query ) throw 'Query must be defined'
        let q = query
        let deletedQuery = includeDeleted ? {} : { _isDeleted: false }
        _idToObjectId( query )

        mongoCollection.find( Object.assign( ( q || {} ), deletedQuery ), { limit, skip } ).toArray( ( err, docs ) => {
            err ? reject( err ) : resolve( docs.map( _idToString ) )
        } )
    } ),
    patch: ( patch, allowUpdateToDeletedRecord = false ) => new Promise( ( resolve, reject ) => {
        if( !patch._id ) {
            throw DBError( 400, '_id required', 'You must include an _id field with your patch' )
        }
        _idToObjectId( patch )
        let query = { _id: patch._id }
        if( !allowUpdateToDeletedRecord ) {
            query._isDeleted = false
        }
        mongoCollection.findOne( query, ( err, doc ) => {
            let newDoc = Object.assign( {}, doc, patch )
            let validation = validate( newDoc )
            if( !validation.valid ) {
                throw DBError( 400, 'Result of patch is invalid', validation.errors.map( e => ( {
                    message: e.message,
                    params: e.params
                } ) ) )
            }
            newDoc._updated = new Date().getTime()
            mongoCollection.updateOne( query, { $set: newDoc }, ( err, res ) => {
                if( err ) {
                    reject( err )
                } else {
                    res.modifiedCount === 1 ? resolve( _idToString( newDoc ) ) : reject( DBError( 404, `${schemaName} not found`, `${schemaName} not found` ) )
                }
            } )
        } )
    } ),
    delete: toggleDelete( true, mongoCollection ),
    recover: toggleDelete( false, mongoCollection ),
    mongoCollection
} )

const toPathStrings = ( next, currPath, paths, depth, filter ) => {
    if( depth === 0 ) return
    if( Array.isArray( next ) ) {
        paths.push( currPath )
        if( next.length > 0 ) {
            for( let i = 0; i < next.length; i++ ) {
                toPathStrings( next[ i ], `${currPath}[${i}]`, paths, depth && depth - 1, filter )
            }
        }
    } else if( next && typeof next === 'object' && filter( next ) ) {
        Object.keys( next )
              .forEach( k => toPathStrings( next[ k ], currPath ? currPath + '.' + k : k, paths, depth && depth - 1, filter ) )
    } else {
        paths.push( currPath )
    }
}

const createIndices = ( props, currPath, collection ) => {
    if( props && typeof props === 'object' ) {
        Object.keys( props )
              .forEach( k => {
                  if( typeof props[ k ].index === 'object' ) {
                      collection.createIndex( { [ currPath ? currPath + '.' + k : k ]: 1 }, props[ k ].index )
                  } else {
                      createIndices( props[ k ], currPath ? currPath + '.' + k : k, collection )
                  }
              } )
    }
}

const connect = () => new Promise( ( resolve, reject ) => {
    MongoClient.connect( dbConfig.url, dbConfig.conn, ( err, client ) => {
        if( err ) {
            reject( err )
            return
        }
        let mongodb = client.db()
        let db = {}
        let schemas = findSchemas( dbConfig.schemaDir )
        if( dbConfig.schemas ) schemas.concat( dbConfig.schemas )
        if( !schemas ) {
            throw new Error( 'You must provide schemas' )
        }
        for( let schemaInfo of schemas ) {
            let collection = schemaInfo.collection
            let schema = schemaInfo.schema
            tv4.addSchema( collection, schema )

            let mongoCollection = mongodb.collection( collection )

            createIndices( schema.properties, null, mongoCollection )

            db[ collection ] = dbCollection(
                collection,
                ( item ) => tv4.validateMultiple( item, collection, true, true ),
                mongoCollection
            )
        }
        if( Object.getOwnPropertySymbols( global ).indexOf( dbSymbol ) === -1 ) {
            global[ dbSymbol ] = db
        }
        console.log( 'muffins ready!' )
        resolve( db )
    } )
} )

let dbSymbol = Symbol.for( 'muffins.db' )
let dbConfig
module.exports = {
    dbSymbol: dbSymbol,
    async get() {
        if( !dbConfig ) throw 'you must init muffins with the config before getting the db'
        return global[ dbSymbol ] ? global[ dbSymbol ] : connect()
    },
    init: ( config ) => {
        dbConfig = config
        dbConfig.conn = Object.assign(
            {
                poolSize: 20,
                useNewUrlParser: true,
                useUnifiedTopology: true,
                reconnectTries: Number.MAX_VALUE,
                bufferMaxEntries: 0,
                socketTimeoutMS: 3000,
                connectTimeoutMS: 3000,
                serverSelectionTimeoutMS: 3000
            },
            config.conn
        )
    }
}