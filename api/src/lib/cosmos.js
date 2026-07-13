const { CosmosClient } = require('@azure/cosmos');

const DATABASE_ID = process.env.COSMOS_DATABASE || 'jetcityit';

let client;
function getClient() {
  if (!client) {
    const connectionString = process.env.COSMOS_CONNECTION_STRING;
    if (!connectionString) throw new Error('COSMOS_CONNECTION_STRING is not configured');
    client = new CosmosClient(connectionString);
  }
  return client;
}

function getContainer(containerId) {
  return getClient().database(DATABASE_ID).container(containerId);
}

module.exports = { getContainer };
