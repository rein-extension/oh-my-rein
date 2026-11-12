// Capability claims are deliberately conservative. Rein does not write generated
// native memory files or treat a model's acknowledgement as a persistence receipt.
export function memoryPolicy(harness:string){
  return {
    personal:{authority:'harness',harness,writesThroughRein:false,writeback:'unverified'},
    project:{authority:'rein-fallback',storage:'sqlite',reason:'No synchronous native memory writeback adapter has been verified.'},
    task:{authority:'rein',storage:'sqlite',scope:'conversation + taskKey'},
    snapshots:'Immutable execution evidence; not a second editable copy of personal memory.',
  };
}
