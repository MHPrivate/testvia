module.exports = function jsonerr(err) {
    return Object.assign(Object.create(err), { name: err.name, message: err.message, stack: err.stack });
};