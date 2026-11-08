'use strict';
const express = require('express');
const db = require('./db');
const { clean } = require('./utils/sanitize');
const app = express();

app.get('/user', async (req, res) => {
  const id = req.query.id;
  const rows = await db.findUser(id);
  res.send('<h1>Hello ' + req.query.name + '</h1>' + JSON.stringify(rows));
});

app.get('/file', (req, res) => {
  const name = req.query.name;
  res.sendFile('/srv/files/' + name);
});

app.get('/safe', (req, res) => {
  res.send(clean(req.query.q));
});

app.listen(3000);
