'use strict';
function clean(s) {
  return String(s).replace(/</g, '&lt;');
}
function unused(a) {
  var b = a;
  return a;
}
module.exports = { clean };
