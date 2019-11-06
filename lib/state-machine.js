// enter({}) - enter actual new state
// enter(null) - enter benign new state
// enter(undefined) - exit & re-enter current state
// enter() - exit & re-enter current state

module.exports = StateMachine;
function StateMachine(initial, assign) {
    if (this instanceof StateMachine === false)
        return new StateMachine(initial);
    var state = {};
    this.enter = function sm_enter(nstate) {
        var args = Array.prototype.slice.call(arguments, 1); // drop nstate from [arguments]
        state.leave && state.leave.apply(this, args); // if available, invoke the oldstate:leave() method
        if (nstate !== undefined) // otherwise leave & re-enter current state
            state = nstate || {};
        return state.enter && state.enter.apply(this, args); // if available, invoke the newstate:enter() method
    };
    this.signal = function sm_signal(s) {
        return state[s] && state[Array.prototype.shift.apply(arguments)].apply(this, arguments);
    };
    assign && Object.assign(this, assign);
    initial && this.enter(initial);
}
