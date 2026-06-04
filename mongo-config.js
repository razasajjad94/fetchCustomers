// Shared MongoDB settings for both pipelines (Compass connection name: MongoConnection)
// Pipeline 1: customers collection  |  Pipeline 2: campaigns collection
const MONGO_URI = "mongodb://localhost:27017";

// Database name = the DB shown in Compass sidebar (not the connection name "MongoConnection")
const MONGO_DB_NAME = "mydb";

// Used by fetch-customer-ids-from-emails.js (lookup customer _id by login_email)
const MONGO_COLLECTION_NAME = "customers";

// Used by fetch-campaign-ids-from-customers.js (find campaigns where customer = ObjectId(...))
const MONGO_BY_CUSTOMER_COLLECTION = "campaigns";
const MONGO_CUSTOMER_FIELD = "customer";

export function getMongoConfig() {
  return {
    uri: MONGO_URI,
    dbName: MONGO_DB_NAME,
    collectionName: MONGO_COLLECTION_NAME,
    byCustomerCollection: MONGO_BY_CUSTOMER_COLLECTION,
    customerField: MONGO_CUSTOMER_FIELD,
  };
}

export function logMongoTarget(config, label) {
  console.log(label || "Mongo target");
  console.log(`Connection: MongoConnection`);
  console.log(`URI: ${config.uri}`);
  console.log(`Database: ${config.dbName}`);
  console.log(`Collection: ${config.collectionName}`);
}

export function logByCustomerTarget(config) {
  console.log("Mongo target (by customer id)");
  console.log(`Connection: MongoConnection`);
  console.log(`URI: ${config.uri}`);
  console.log(`Database: ${config.dbName}`);
  console.log(`Collection: ${config.byCustomerCollection}`);
  console.log(`Filter field: ${config.customerField}`);
}
