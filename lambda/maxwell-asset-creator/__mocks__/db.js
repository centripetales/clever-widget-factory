// Shared mock for /opt/nodejs/db — stateful singleton controlled by tests
const state = {
  mockClient: null,
};

async function getDbClient() {
  if (state.mockClient) {
    return state.mockClient;
  }
  return { query: async () => ({ rows: [] }), release: () => {} };
}

// Test helpers
function __setMockClient(client) {
  state.mockClient = client;
}

function __reset() {
  state.mockClient = null;
}

module.exports = { getDbClient, __setMockClient, __reset };
