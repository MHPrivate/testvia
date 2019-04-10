// permitted trick, see 'To change it, you could use Object.defineProperty() though.' here:
//  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/name#Inferred_function_names
module.exports = function setFunctionName(name, func) {
    var desc = Object.getOwnPropertyDescriptor(func, 'name');
    desc.writable || Object.defineProperty(func, 'name', { writable: true }); // conditionally make 'name' _writable_
    Object.defineProperty(func, 'name', { value: name, writable: desc.writable }); // set 'name' and restore _writeable_
    return func; // return func to enable one-line function creation & naming
}
