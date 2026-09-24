function number(facts, key) { if (!Number.isFinite(facts?.[key]) || facts[key] < 0) throw new Error(`missing/invalid owner counter ${key}`); return facts[key]; }
function checkFacts(facts) {
  for (const key of ['durableEvents','backlog','backlogHighWater','implicitCliStarts','fullHistorySidebarReads','worktreeMutations','childProcesses','acceptedPrompts','heapBytes','rssBytes']) number(facts, key);
  if (facts.backlogHighWater < facts.backlog) throw new Error('invalid owner backlog high water');
  for (const key of ['focusStable','draftStable','selectedStable']) if (facts[key] !== true) throw new Error(`unstable owner fact ${key}`);
  for (const key of ['implicitCliStarts','fullHistorySidebarReads','worktreeMutations','acceptedPrompts']) if (facts[key] !== 0) throw new Error(`unexpected owner side effect ${key}: ${facts[key]}`);
  return facts;
}
export function validateProductFacts(facts, {mode, phase}) {
  checkFacts(facts);
  if (mode === 'acceptance') {
    const required = phase.startsWith('post-') ? ['host'] : ['host','renderer'];
    for (const processName of required) {
      const processFacts = facts.processes?.[processName];
      if (!processFacts || !Number.isFinite(processFacts.heapBytes) || processFacts.heapBytes <= 0 || !Number.isFinite(processFacts.rssBytes) || processFacts.rssBytes <= 0) throw new Error(`missing product process memory: ${processName}`);
    }
  }
  return facts;
}
export function checkSample(sample) {
  for (const key of ['typedInputMs','sessionSwitchMs']) number(sample, key);
  for (const key of ['focusStable','draftStable','selectedStable','worktreesStable']) if (sample[key] !== true) throw new Error(`unstable mounted UI ${key}`);
}
