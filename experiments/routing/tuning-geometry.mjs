import { distanceM } from './engines.mjs';

export function referenceFromSegments(run, feedback) {
  if (feedback.runId !== run.id || feedback.variant !== 'selected') throw new Error('Reference feedback must identify this chosen-roads run.');
  const coordinates = [];
  const sources = [];
  for (const segment of feedback.referenceSegments) {
    const result = run.results.find(r => r.id === segment.resultId);
    if (!result?.normalized || result.caseId !== feedback.caseId || result.variant !== feedback.variant) throw new Error('Reference segment does not match its result.');
    const line = result.normalized.geometry.coordinates;
    const locate = number => {
      const point = result.points[number - 1]?.coord;
      if (!point) throw new Error('Reference point is missing.');
      const index = line.reduce((best,c,i) => distanceM(c,point) < distanceM(line[best],point) ? i : best,0);
      // Stops may have snapped away from their request; shaping transitions must be close.
      if (number !== 1 && number !== result.points.length && distanceM(line[index],point) > 1) throw new Error('Reference shaping point is not on its route.');
      return index;
    };
    const from = locate(segment.fromPoint), to = locate(segment.throughPoint);
    if (to <= from) throw new Error('Reference segments must follow route order.');
    const selected = line.slice(from,to+1).map(c => c.slice(0,2));
    if (coordinates.length && distanceM(coordinates.at(-1),selected[0]) > 1) throw new Error('Reference segments do not meet within one metre.');
    coordinates.push(...selected);
    sources.push({resultId:result.id,fromPoint:segment.fromPoint,throughPoint:segment.throughPoint});
  }
  if (coordinates.length < 2) throw new Error('Reference needs route segments.');
  return {type:'Feature',properties:{runId:run.id,caseId:feedback.caseId,sources,description:'Composite of rider-selected segments. Not a route returned by an engine.'},geometry:{type:'LineString',coordinates}};
}

// Local Graz comparisons, sampled every five metres. These measure geometric agreement, not safety.
export function compareGeometry(coordinates, reference) {
  const latitude = reference[0][1] * Math.PI / 180;
  const scale = Math.PI * 6371008.8 / 180;
  const project = c => [c[0]*scale*Math.cos(latitude), c[1]*scale];
  const candidate = coordinates.map(project), target = reference.map(project);
  function sample(from, to) {
    let lengthM = 0, outside3mM = 0, maximumM = 0;
    for (let i=1;i<from.length;i++) {
      const a=from[i-1],b=from[i],length=Math.hypot(b[0]-a[0],b[1]-a[1]);
      const count=Math.max(1,Math.ceil(length/5));
      lengthM+=length;
      for (let j=0;j<count;j++) {
        const p=[a[0]+(b[0]-a[0])*(j+0.5)/count,a[1]+(b[1]-a[1])*(j+0.5)/count];
        let nearest=Infinity;
        for(let k=1;k<to.length;k++) {
          const c=to[k-1],d=to[k],dx=d[0]-c[0],dy=d[1]-c[1],squared=dx*dx+dy*dy;
          const t=squared ? Math.max(0,Math.min(1,((p[0]-c[0])*dx+(p[1]-c[1])*dy)/squared)) : 0;
          nearest=Math.min(nearest,Math.hypot(p[0]-c[0]-t*dx,p[1]-c[1]-t*dy));
        }
        maximumM=Math.max(maximumM,nearest);
        if(nearest>3) outside3mM+=length/count;
      }
    }
    return {lengthM,outside3mM,maximumM};
  }
  const forward=sample(candidate,target), reverse=sample(target,candidate);
  return {
    candidateLengthM:forward.lengthM, referenceLengthM:reverse.lengthM,
    candidateOutside3mM:forward.outside3mM, referenceMissed3mM:reverse.outside3mM,
    maximumSampledSeparationM:Math.max(forward.maximumM,reverse.maximumM),
    lengthDifferenceM:forward.lengthM-reverse.lengthM,
    startSeparationM:distanceM(coordinates[0],reference[0]), endSeparationM:distanceM(coordinates.at(-1),reference.at(-1)),
  };
}
