import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateOptions,prepareArtifactBase,isolation,applyIsolation,runLoad} from './runner.mjs';

export async function runCli() {
  const args=process.argv.slice(2);
  const val=flag=>{const i=args.indexOf(flag);return i<0?undefined:args[i+1];};
  const driverPath=val('--driver');
  if(!driverPath || !isAbsolute(driverPath)) throw new Error('--driver requires an absolute trusted .mjs path (no built-in production driver)');
  // 中文：导入驱动前完成隔离，不能把账户环境注入任何产品模块。
  const mode=val('--mode')??'acceptance', delivery=val('--delivery')??'desktop-continuous';
  if(['smoke','benchmark'].includes(mode) && (val('--duration-ms')===undefined || val('--events')===undefined)) throw new Error(`${mode} requires explicit --duration-ms and --events`);
  const numbers={'--duration-ms':'durationMs','--events':'eventCount','--worktrees':'worktreeCount','--sessions':'sessionCount','--expanded':'expandedCount','--sample-every-ms':'sampleEveryMs','--reconnect-every-ms':'reconnectEveryMs','--idle-ms':'idleMs','--max-backlog':'maxBacklog','--max-owned-children':'maxOwnedChildren'};
  const numeric=Object.fromEntries(Object.entries(numbers).filter(([flag])=>val(flag)!==undefined).map(([flag,key])=>[key,Number(val(flag))]));
  const options=validateOptions({mode,delivery,benchmarkDatasetId:val('--benchmark-dataset-id'),...numeric});
  const base=resolve(val('--artifact-base')??tmpdir());
  const safeBase=await prepareArtifactBase(base);
  const launch=await mkdtemp(join(safeBase,'load-launch-'));
  applyIsolation(await isolation(launch));
  const driver=(await import(pathToFileURL(driverPath).href)).default;
  const result=await runLoad({driver,...options,artifactBase:base,baselinePath:val('--baseline'),sourceCheckout:val('--source-checkout'),buildArtifactPath:val('--build-artifact'),buildProvenancePath:val('--build-provenance'),isolateProcessEnv:true});
  console.log(JSON.stringify({status:result.status,artifacts:result.artifacts,elapsedMs:Math.round(result.elapsedMs),failures:result.failures}));
  if(result.status==='failed') process.exitCode=1;
}
