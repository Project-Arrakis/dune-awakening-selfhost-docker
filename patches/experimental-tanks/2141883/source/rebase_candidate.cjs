// Offline candidate only. Never alter the shared BaseItems/CDT registries.
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.resolve(process.argv[2] || __dirname);
const assets = 'DuneSandbox/Content/Dune/Systems';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const stock = relative => read(path.join(root, 'server-2141883-legacy', assets, relative+'.uasset.json'));
const out = path.join(root, 'candidate-2141883-json');
const written = [];
const write = (relative, doc) => {
  doc.NamesReferencedFromExportDataCount = doc.NameMap.length;
  const target = path.join(out, assets, relative+'.uasset.json');
  fs.mkdirSync(path.dirname(target), {recursive:true});
  fs.writeFileSync(target, JSON.stringify(doc,null,2)+'\n');
  written.push(relative);
};
const nameIndex = (doc,name) => {
  let index = doc.NameMap.indexOf(name);
  if (index < 0) { index=doc.NameMap.length; doc.NameMap.push(name); }
  return index;
};
function* walk(value) {
  if (value && typeof value === 'object') {
    yield value;
    for (const child of Object.values(value)) yield* walk(child);
  }
}
const knownItems = new Set(read(path.join(root,'CDT_BaseItems-2141883-rows.json')).rows.map(row=>row.identity.resolved));
const modules = stock('Vehicles/Modules/DT_Tank_Modules');
const moduleChanges=[];
const nativeZero = new Set(['TankChassis_0','TankDart_0','TankEngine_0','TankGenerator_0','TankHull_0','TankHullFront_0','TankLocomotionFrontLeft_0','TankLocomotionFrontRight_0','TankLocomotionBackLeft_0','TankLocomotionBackRight_0']);
for (const row of modules.Exports[0].Table.Data) {
  if (!nativeZero.has(row.Name) && !row.Name.endsWith('_6')) continue;
  const property=row.Value.find(prop=>prop.Name==='m_ItemTemplate');
  assert(property, row.Name);
  const raw=Buffer.from(property.Value,'base64');
  assert.equal(raw.length,8);
  const previousName=modules.NameMap[raw.readInt32LE(0)];
  const previousNumber=raw.readInt32LE(4);
  // Existing Tank items are kept. Only the two absent item identities use
  // their already-stock PSU/tread equivalents, not synthetic registry aliases.
  const itemName = {TankGenerator:'TreadwheelGenerator',TankLocomotion:'TreadwheelLocomotion'}[previousName] || previousName;
  const tierNumber=7;
  assert(knownItems.has(itemName+'_6'), row.Name+': missing stock item '+itemName);
  raw.writeInt32LE(nameIndex(modules,itemName),0);
  raw.writeInt32LE(tierNumber,4);
  property.Value=raw.toString('base64');
  if(previousName!==itemName || previousNumber!==tierNumber) moduleChanges.push({row:row.Name,from:previousName+':'+previousNumber,to:itemName+':'+tierNumber});
  const swatches=[...walk(row)].filter(prop=>prop.Name==='SwatchId');
  assert.equal(swatches.length,1,row.Name);
  swatches[0].Value='GVehDyePackHark01';
}
nameIndex(modules,'GVehDyePackHark01');
write('Vehicles/Modules/DT_Tank_Modules',modules);

const templates=stock('Vehicles/DT_VehicleTemplates');
const previous=read(path.join(root,'inputs/work/r5_4_templates.json'));
assert.deepEqual(templates.NameMap.slice(0,181),previous.NameMap.slice(0,181));
function tankProperty(doc) {
  const data=Buffer.from(doc.Exports[0].Data,'base64');
  const find=name=>{
    const index=doc.NameMap.indexOf(name), hits=[];
    assert(index>=0,name);
    for(let pos=0;pos<=data.length-8;pos++)if(data.readInt32LE(pos)===index&&data.readInt32LE(pos+4)===0)hits.push(pos);
    assert.equal(hits.length,1,name);return hits[0];
  };
  const fire=find('T6_CombatFire'),rocket=find('T6_CombatDart'),hits=[];
  for(let pos=0;pos<fire-49;pos++)if(data.readInt32LE(pos)===doc.NameMap.indexOf('m_Templates')&&data.readInt32LE(pos+4)===0){
    const size=Number(data.readBigInt64LE(pos+16));
    if(pos+49<fire&&pos+41+size>rocket)hits.push(pos);
  }
  assert.equal(hits.length,1);
  const start=hits[0];return {data,start,end:start+41+Number(data.readBigInt64LE(start+16))};
}
const donor=tankProperty(previous),current=tankProperty(templates);
const six=Buffer.from(donor.data.subarray(donor.start,donor.end));
assert.equal(six.readInt32LE(45),6);assert.equal(six.length,49+6*293);
const presetNames=[];
for(let row=0;row<6;row++){
  const offset=49+row*293,name=previous.NameMap[six.readInt32LE(offset)];
  presetNames.push(name);six.writeInt32LE(nameIndex(templates,name),offset);
}
assert.deepEqual(presetNames,['T0','T6_CombatFire','T6_CombatDart','T6_DartInventory','T6_RocketInventory','T6_FireInventory']);
templates.Exports[0].Data=Buffer.concat([current.data.subarray(0,current.start),six,current.data.subarray(current.end)]).toString('base64');
write('Vehicles/DT_VehicleTemplates',templates);

const buggy=stock('Vehicles/Modules/DT_Buggy_Modules');
const buggyData=Buffer.from(buggy.Exports[0].Data,'base64');
function pairs(name,number,start=0,end=buggyData.length){
  const index=buggy.NameMap.indexOf(name),hits=[];assert(index>=0,name);
  for(let pos=start;pos<=end-8;pos++)if(buggyData.readInt32LE(pos)===index&&buggyData.readInt32LE(pos+4)===number)hits.push(pos);
  return hits;
}
const starts=pairs('BuggyLauncher',7),ends=pairs('BuggyLauncher',8);
assert.equal(starts.length,2);assert.equal(ends.length,2);
const start=starts[0],end=ends[0];assert(end>start);
const swatches=pairs('SwatchId',0,start,end);assert.equal(swatches.length,1);
const swatch=swatches[0];assert.equal(buggy.NameMap[buggyData.readInt32LE(swatch+8)],'NameProperty');assert.equal(buggyData.readInt32LE(swatch+16),8);assert.equal(buggyData[swatch+24],0);
buggyData.writeInt32LE(nameIndex(buggy,'GVehDyePackHark01'),swatch+25);buggyData.writeInt32LE(0,swatch+29);
for(const [from,to] of [['Rockets Module','TurretModule'],['EVehicleModel::Buggy','EVehicleModel::Tank']]){
  const matches=pairs(from,0,start,end);assert.equal(matches.length,1,from);
  buggyData.writeInt32LE(nameIndex(buggy,to),matches[0]);
}
buggy.Exports[0].Data=buggyData.toString('base64');
write('Vehicles/Modules/DT_Buggy_Modules',buggy);

const blueprint=stock('Vehicles/Blueprints/GroundVehicles/BP_Tank_CHOAM');
let deprecated=0,shortcut=0;
for(const exp of blueprint.Exports)for(const prop of Array.isArray(exp.Data)?exp.Data:[]){
  if(exp.ObjectName==='Default__BP_Tank_CHOAM_C'&&prop.Name==='m_bIsDeprecated'){assert.equal(prop.Value,true);prop.Value=false;deprecated++;}
  if(exp.ObjectName==='DriverSeat_GEN_VARIABLEAbilityShortcuts'&&prop.Name==='SkipSaving'){assert.equal(prop.Value,true);prop.Value=false;shortcut++;}
}
assert.equal(deprecated,1);assert.equal(shortcut,1);
write('Vehicles/Blueprints/GroundVehicles/BP_Tank_CHOAM',blueprint);
const report={candidateOnly:true,build:'2141883-0-shipping',unchangedSharedTables:['CDT_BaseItems','DT_BaseItems_Vehicles','DT_ItemTableBuildables'],packages:written,presetNames,moduleChanges,gameplayVerified:false};
fs.writeFileSync(path.join(root,'candidate-asset-report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
