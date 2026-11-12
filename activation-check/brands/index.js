// Add a new brand by creating a module next to nothing.js and putting it in
// this list. A module needs:
//   id, label, matches(item) -> boolean, run({page, item, log, setPhase}) -> result
// See _template.js for a commented starting point.
const adapters = [
  require('./nothing'),
];

function findAdapter(item) {
  return adapters.find(adapter => adapter.matches(item)) || null;
}

function listAdapters() {
  return adapters.map(adapter => ({ id: adapter.id, label: adapter.label }));
}

module.exports = { adapters, findAdapter, listAdapters };
