module.exports = exports = Tasks;

function Tasks() {
    var tasks = Object.assign([], {
        add: function add(task) {
            return this.push({ done: undefined, task: task });
        },
        get: function get(next) {
            var entry = this.reduce(function (wksp, entry, idx, arr) {
                if (next && entry.done === false)
                    entry.done = true;
                if (entry.done === true) // skip this task
                    return wksp;
                if (!wksp)
                    return entry;
                return (wksp.task.priority || 0) < entry.task.priority ? entry : wksp;
            }, undefined);
            (entry || {}).done = false;
            return entry && entry.task;
        },
    });
    return Object.defineProperties(tasks, {
        add: { enumerable: false },
        get: { enumerable: false },
    });
}
