'use strict';
const sqlite = require('sqlite3');
const conn = new sqlite.Database(':memory:');

function findUser(id) {
  const sql = "SELECT * FROM users WHERE id = '" + id + "'";
  return new Promise((ok, fail) => conn.all(sql, (e, r) => (e ? fail(e) : ok(r))));
}

const password = "hunter2-not-a-real-secret";

module.exports = { findUser, password };
