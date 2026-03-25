import express from "express";

const router = express.Router();

const getOrientations = (l, w, h) => [
  { l, w, h }, { l, h, w },
  { w, l, h }, { w, h, l },
  { h, l, w }, { h, w, l }
];

router.post("/analyse-stuffing", async (req, res) => {
  try {
    const { type, container, cone, conesPerCarton2, carton1, carton2 } = req.body;
    const count1 = Number(cone.conesPerCarton);
    const count2 = Number(conesPerCarton2 || count1);
    
    console.log(`Analysing stuffing: Type=${type}, Carton1=${!!carton1}, Carton2=${!!carton2}, Counts=${count1}/${count2}`);
    // Ideal Safety Gap range: 50mm to 120mm
    const IDEAL_MIN = 50;
    const IDEAL_MAX = 120;
    
    // Hard search limits (wide tolerance to ensure options are always shown)
    const SEARCH_BUFFER = 10; // Minimum physical clearance to even attempt a fit
    const SEARCH_MAX_GAP = 500; // Skip if more than 50cm is wasted
    
    const effL = container.length - SEARCH_BUFFER;
    const effW = container.width - SEARCH_BUFFER;
    const effH = container.height - SEARCH_BUFFER;

    let allResults = [];

    const getGapStatus = (l, w, h) => {
      const check = (v) => (v >= IDEAL_MIN && v <= IDEAL_MAX);
      return {
        l: check(l) ? 'ok' : (l < IDEAL_MIN ? 'low' : 'high'),
        w: check(w) ? 'ok' : (w < IDEAL_MIN ? 'low' : 'high'),
        h: check(h) ? 'ok' : (h < IDEAL_MIN ? 'low' : 'high'),
        isIdeal: check(l) && check(w) && check(h)
      };
    };

    const calculateMulti = (o1, o2, c1, c2) => {
      const results = [];

      // Strategy 1: Stacking layers of C1 and C2 along Height
      const pL1 = Math.floor(effL / o1.l);
      const pW1 = Math.floor(effW / o1.w);
      const pL2 = Math.floor(effL / o2.l);
      const pW2 = Math.floor(effW / o2.w);
      
      if (pL1 * pW1 > 0 && pL2 * pW2 > 0) {
        for (let n1 = 1; n1 * o1.h < effH; n1++) {
          const n2 = Math.floor((effH - (n1 * o1.h)) / o2.h);
          if (n2 > 0) {
            const total1 = n1 * pL1 * pW1;
            const total2 = n2 * pL2 * pW2;
            const tCones = (total1 * c1) + (total2 * c2);
            
            const unusedL = container.length - Math.min(pL1 * o1.l, pL2 * o2.l);
            const unusedW = container.width - Math.min(pW1 * o1.w, pW2 * o2.w);
            const unusedH = container.height - (n1 * o1.h + n2 * o2.h);

            // Constraint: Only exclude if it's way outside reasonable packing
            if (unusedL <= SEARCH_MAX_GAP && unusedW <= SEARCH_MAX_GAP && unusedH <= SEARCH_MAX_GAP) {
              results.push({
                cartonL: o1.l / 10, cartonW: o1.w / 10, cartonH: o1.h / 10,
                fitL: pL1, fitW: pW1, fitH: n1,
                totalCartons: total1,
                totalCones: tCones,
                totalWeight: tCones * cone.weight,
                layout: o1.layout || { rows: 0, cols: 0, layers: 0 },
                unusedL, unusedW, unusedH,
                gapStatus: getGapStatus(unusedL, unusedW, unusedH),
                isMulti: true,
                carton2: { 
                  l: o2.l / 10, w: o2.w / 10, h: o2.h / 10, 
                  totalCartons: total2, fitL: pL2, fitW: pW2, fitH: n2,
                  layout: o2.layout || { rows: 0, cols: 0, layers: 0 },
                  conesPerCarton: c2
                }
              });
            }
          }
        }
      }

      // Strategy 2: Side-by-side along Length
      const area1 = Math.floor(effW / o1.w) * Math.floor(effH / o1.h);
      const area2 = Math.floor(effW / o2.w) * Math.floor(effH / o2.h);
      if (area1 > 0 && area2 > 0) {
        for (let l1 = 1; l1 * o1.l < effL; l1++) {
          const l2 = Math.floor((effL - (l1 * o1.l)) / o2.l);
          if (l2 > 0) {
            const t1 = l1 * area1;
            const t2 = l2 * area2;
            const tCones = (t1 * c1) + (t2 * c2);

            const unusedL = container.length - (l1 * o1.l + l2 * o2.l);
            const unusedW = container.width - Math.min(Math.floor(effW / o1.w) * o1.w, Math.floor(effW / o2.w) * o2.w);
            const unusedH = container.height - Math.min(Math.floor(effH / o1.h) * o1.h, Math.floor(effH / o2.h) * o2.h);

            if (unusedL <= SEARCH_MAX_GAP && unusedW <= SEARCH_MAX_GAP && unusedH <= SEARCH_MAX_GAP) {
              results.push({
                cartonL: o1.l / 10, cartonW: o1.w / 10, cartonH: o1.h / 10,
                fitL: l1, fitW: Math.floor(effW / o1.w), fitH: Math.floor(effH / o1.h),
                totalCartons: t1,
                totalCones: tCones,
                totalWeight: tCones * cone.weight,
                layout: o1.layout || { rows: 0, cols: 0, layers: 0 },
                unusedL, unusedW, unusedH,
                gapStatus: getGapStatus(unusedL, unusedW, unusedH),
                isMulti: true,
                carton2: { 
                  l: o2.l / 10, w: o2.w / 10, h: o2.h / 10, 
                  totalCartons: t2, fitL: l2, fitW: Math.floor(effW / o2.w), fitH: Math.floor(effH / o2.h),
                  layout: o2.layout || { rows: 0, cols: 0, layers: 0 },
                  conesPerCarton: c2
                }
              });
            }
          }
        }
      }

      // Strategy 3: Side-by-side along Width
      const side1 = Math.floor(effL / o1.l) * Math.floor(effH / o1.h);
      const side2 = Math.floor(effL / o2.l) * Math.floor(effH / o2.h);
      if (side1 > 0 && side2 > 0) {
        for (let w1 = 1; w1 * o1.w < effW; w1++) {
          const w2 = Math.floor((effW - (w1 * o1.w)) / o2.w);
          if (w2 > 0) {
            const t1 = w1 * side1;
            const t2 = w2 * side2;
            const tCones = (t1 * c1) + (t2 * c2);

            const unusedL = container.length - Math.min(Math.floor(effL / o1.l) * o1.l, Math.floor(effL / o2.l) * o2.l);
            const unusedW = container.width - (w1 * o1.w + w2 * o2.w);
            const unusedH = container.height - Math.min(Math.floor(effH / o1.h) * o1.h, Math.floor(effH / o2.h) * o2.h);

            if (unusedL <= SEARCH_MAX_GAP && unusedW <= SEARCH_MAX_GAP && unusedH <= SEARCH_MAX_GAP) {
              results.push({
                cartonL: o1.l / 10, cartonW: o1.w / 10, cartonH: o1.h / 10,
                fitL: Math.floor(effL / o1.l), fitW: w1, fitH: Math.floor(effH / o1.h),
                totalCartons: t1,
                totalCones: tCones,
                totalWeight: tCones * cone.weight,
                layout: o1.layout || { rows: 0, cols: 0, layers: 0 },
                unusedL, unusedW, unusedH,
                gapStatus: getGapStatus(unusedL, unusedW, unusedH),
                isMulti: true,
                carton2: { 
                  l: o2.l / 10, w: o2.w / 10, h: o2.h / 10, 
                  totalCartons: t2, fitL: Math.floor(effL / o2.l), fitW: w2, fitH: Math.floor(effH / o2.h),
                  layout: o2.layout || { rows: 0, cols: 0, layers: 0 },
                  conesPerCarton: c2
                }
              });
            }
          }
        }
      }
      return results;
    };

    const processSingle = (carton) => {
      if (!carton) return;
      const oris = getOrientations(Number(carton.l), Number(carton.w), Number(carton.h));
      oris.forEach(ori => {
        if (ori.l > 1000 || ori.w > 1000 || ori.h > 1000) return;
        
        const fitL = Math.floor(effL / ori.l);
        const fitW = Math.floor(effW / ori.w);
        const fitH = Math.floor(effH / ori.h);
        if (fitL > 0 && fitW > 0 && fitH > 0) {
          const totalCartons = fitL * fitW * fitH;
          const totalCones = totalCartons * count1;

          const unusedL = container.length - (fitL * ori.l);
          const unusedW = container.width - (fitW * ori.w);
          const unusedH = container.height - (fitH * ori.h);

          if (unusedL <= SEARCH_MAX_GAP && unusedW <= SEARCH_MAX_GAP && unusedH <= SEARCH_MAX_GAP) {
            allResults.push({
              cartonL: ori.l / 10, cartonW: ori.w / 10, cartonH: ori.h / 10,
              fitL, fitW, fitH, totalCartons,
              totalCones,
              totalWeight: totalCones * cone.weight,
              layout: carton.layout || { rows: 0, cols: 0, layers: 0 },
              unusedL, unusedW, unusedH,
              gapStatus: getGapStatus(unusedL, unusedW, unusedH),
            });
          }
        }
      });
    };

    const findAllLayouts = (total) => {
      const layouts = [];
      for (let l = 1; l <= total; l++) {
        if (total % l === 0) {
          const remaining = total / l;
          for (let r = 1; r <= remaining; r++) {
            if (remaining % r === 0) {
              const c = remaining / r;
              layouts.push({ rows: r, cols: c, layers: l });
            }
          }
        }
      }
      return layouts;
    };

    if (type === 'multi') {
      if (carton1 && carton2) {
        // Manual Multi
        const oris1 = getOrientations(Number(carton1.l), Number(carton1.w), Number(carton1.h));
        const oris2 = getOrientations(Number(carton2.l), Number(carton2.w), Number(carton2.h));
        oris1.forEach(o1 => {
          if (o1.l > 1000 || o1.w > 1000 || o1.h > 1000) return;
          oris2.forEach(o2 => {
            if (o2.l > 1000 || o2.w > 1000 || o2.h > 1000) return;
            allResults.push(...calculateMulti(o1, o2, count1, count2));
          });
        });
      } else {
        // Auto Multi: Try all combinations of layouts for BOTH counts
        const layouts1 = findAllLayouts(count1);
        const layouts2 = findAllLayouts(count2);
        
        const candidates1 = layouts1.map(layout => ({
          l: cone.diameter * layout.cols,
          w: cone.diameter * layout.rows,
          h: cone.height * layout.layers,
          layout
        })).filter(c => c.l <= 1000 && c.w <= 1000 && c.h <= 1000);

        const candidates2 = layouts2.map(layout => ({
          l: cone.diameter * layout.cols,
          w: cone.diameter * layout.rows,
          h: cone.height * layout.layers,
          layout
        })).filter(c => c.l <= 1000 && c.w <= 1000 && c.h <= 1000);

        for (let i = 0; i < candidates1.length; i++) {
          for (let j = 0; j < candidates2.length; j++) {
            const oris1 = getOrientations(candidates1[i].l, candidates1[i].w, candidates1[i].h);
            const oris2 = getOrientations(candidates2[j].l, candidates2[j].w, candidates2[j].h);
            oris1.forEach(o1 => {
              if (o1.l > 1000 || o1.w > 1000 || o1.h > 1000) return;
              oris2.forEach(o2 => {
                if (o2.l > 1000 || o2.w > 1000 || o2.h > 1000) return;
                // Ensure combinations are actually different if counts are same
                if (count1 !== count2 || o1.l !== o2.l || o1.w !== o2.w || o1.h !== o2.h) {
                   allResults.push(...calculateMulti(
                     {...o1, layout: candidates1[i].layout}, 
                     {...o2, layout: candidates2[j].layout},
                     count1, count2
                   ));
                }
              });
            });
          }
        }
      }
      
      // Strict Filter: Only return configurations that actually use two sizes
      allResults = allResults.filter(r => r.isMulti && r.totalCartons > 0 && (r.carton2?.totalCartons || 0) > 0);
    } else {
      if (carton1) {
        processSingle(carton1);
      } else {
        const layouts = findAllLayouts(cone.conesPerCarton);
        layouts.forEach(layout => {
          const cL = cone.diameter * layout.cols;
          const cW = cone.diameter * layout.rows;
          const cH = cone.height * layout.layers;
          processSingle({ l: cL, w: cW, h: cH, layout });
        });
      }
    }

    const sorted = allResults.sort((a, b) => {
      // Prioritize multi-size results when type is multi
      if (type === 'multi') {
        const aIsCombo = a.isMulti && a.totalCartons > 0 && (a.carton2?.totalCartons || 0) > 0;
        const bIsCombo = b.isMulti && b.totalCartons > 0 && (b.carton2?.totalCartons || 0) > 0;
        if (aIsCombo && !bIsCombo) return -1;
        if (!aIsCombo && bIsCombo) return 1;
      }
      return b.totalWeight - a.totalWeight;
    });
    const unique = [];
    const seen = new Set();
    for (const res of sorted) {
      const key = res.isMulti 
        ? `${res.cartonL}-${res.cartonW}-${res.cartonH}-${res.carton2?.l}-${res.carton2?.w}-${res.carton2?.h}-${res.fitL}-${res.fitW}-${res.fitH}-${res.carton2?.fitL}-${res.carton2?.fitW}-${res.carton2?.fitH}`
        : `${res.cartonL}-${res.cartonW}-${res.cartonH}`;
      if (!seen.has(key)) {
        unique.push(res);
        seen.add(key);
      }
      if (unique.length >= 3) break;
    }

    res.json({ success: true, results: unique });
  } catch (error) {
    console.error("Stuffing analysis error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
