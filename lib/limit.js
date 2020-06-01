module.exports = function limit(arr /*, v, ... */) {
    if (typeof arr === 'number')
        return Object.assign([], { limit: arr }, arguments[1]);
    if (!Array.isArray(arr))
        return;
    for (var i = 1; i < arguments.length; ++i)
        arr.unshift(arguments[i]);
    if (arr.limit)
        while (arr.length > arr.limit)
            arr.pop();
    return arr;
}
