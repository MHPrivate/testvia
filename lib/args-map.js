module.exports = function argsMap(args) {
    return Array.from(args).map(function (arg, idx, arr) {
        if (arg === null)
            return null;
        if (arg instanceof Error)
            return arg.name + ': ' + arg.message;
        if (typeof arg === 'function')
            return 'function';
        if (typeof arg === 'object')
            try {
                return JSON.stringify(arg);
            } catch (ex) {
                return arg.constructor.name;
            }
        return arg;
    });
}
