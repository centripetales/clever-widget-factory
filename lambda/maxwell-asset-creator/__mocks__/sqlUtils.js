module.exports = {
  escapeLiteral: (val) => String(val).replace(/'/g, "''"),
};
