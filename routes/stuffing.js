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
    const SEARCH_MAX_GAP = 5000; // Increase to show almost any valid combination
    
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

    const findAllLayouts = (total) => {
      const layouts = [];
      for (let l = 1; l <= total; l++) {
        if (total % l === 0) {
          const remaining = total / l;
          for (let r = 1; r <= remaining; r++) {
            if (remaining % r === 0) {
              const c = remaining / r;
              layouts.push({ rows: r, cols: c, layers: l, total });
            }
          }
        }
      }
      return layouts;
    };

    const getBestLayoutForCarton = (l, w, h, totalCones) => {
      const layouts = findAllLayouts(totalCones);
      for (const lay of layouts) {
        const orientations = [
          { l: lay.cols * cone.diameter, w: lay.rows * cone.diameter, h: lay.layers * cone.height },
          { l: lay.rows * cone.diameter, w: lay.cols * cone.diameter, h: lay.layers * cone.height }
        ];
        for (const ori of orientations) {
          if (ori.l <= l + 5 && ori.w <= w + 5 && ori.h <= h + 5) return lay;
        }
      }
      return { rows: 0, cols: 0, layers: 0 };
    };

    const calculateMulti = (o1, o2, c1, c2) => {
      const results = [];
      const oris2 = getOrientations(o2.l, o2.w, o2.h);
      
      const maxL1 = Math.floor(effL / o1.l);
      const maxW1 = Math.floor(effW / o1.w);
      const maxH1 = Math.floor(effH / o1.h);

      // We only try the best few configurations to avoid result bloat
      // Trying from max downwards
      for (let nL1 = maxL1; nL1 >= Math.max(0, maxL1 - 2); nL1--) {
        for (let nW1 = maxW1; nW1 >= Math.max(0, maxW1 - 2); nW1--) {
          for (let nH1 = maxH1; nH1 >= Math.max(0, maxH1 - 2); nH1--) {
            if (nL1 * nW1 * nH1 === 0) continue;
            
            const total1 = nL1 * nW1 * nH1;
            const slabs = [
              { l: effL - nL1 * o1.l, w: effW, h: effH, type: 'L' },
              { l: nL1 * o1.l, w: effW - nW1 * o1.w, h: effH, type: 'W' },
              { l: nL1 * o1.l, w: nW1 * o1.w, h: effH - nH1 * o1.h, type: 'H' }
            ];

            let total2 = 0;
            let occL = nL1 * o1.l;
            let occW = nW1 * o1.w;
            let occH = nH1 * o1.h;
            
            let slabDetails = [];

            slabs.forEach(s => {
              let bestSlab = { count: 0, l: 0, w: 0, h: 0, fitL: 0, fitW: 0, fitH: 0 };
              oris2.forEach(o => {
                const fL = Math.floor(s.l / o.l);
                const fW = Math.floor(s.w / o.w);
                const fH = Math.floor(s.h / o.h);
                if (fL * fW * fH > bestSlab.count) {
                  bestSlab = { count: fL * fW * fH, l: fL * o.l, w: fW * o.w, h: fH * o.h, fitL: fL, fitW: fW, fitH: fH };
                }
              });
              if (bestSlab.count > 0) {
                total2 += bestSlab.count;
                slabDetails.push(bestSlab);
                if (s.type === 'L') occL += bestSlab.l;
                if (s.type === 'W') occW = Math.max(occW, nW1 * o1.w + bestSlab.w);
                if (s.type === 'H') occH = Math.max(occH, nH1 * o1.h + bestSlab.h);
              }
            });

            if (total2 === 0) continue;

            const tCones = (total1 * c1) + (total2 * c2);
            const unusedL = container.length - occL;
            const unusedW = container.width - occW;
            const unusedH = container.height - occH;

            if (unusedL <= SEARCH_MAX_GAP && unusedW <= SEARCH_MAX_GAP && unusedH <= SEARCH_MAX_GAP) {
              const lay1 = o1.layout || getBestLayoutForCarton(o1.l, o1.w, o1.h, c1);
              const lay2 = o2.layout || getBestLayoutForCarton(o2.l, o2.w, o2.h, c2);
              
              // For carton2 fit specs, we take the largest slab or just the total sum
              // We'll report the fit dimensions of the primary slab for C2
              const primarySlab = slabDetails.sort((a,b) => b.count - a.count)[0] || { fitL:0, fitW:0, fitH:0 };

              results.push({
                cartonL: o1.l / 10, cartonW: o1.w / 10, cartonH: o1.h / 10,
                fitL: nL1, fitW: nW1, fitH: nH1,
                totalCartons: total1,
                totalCones: tCones,
                totalWeight: tCones * cone.weight,
                layout: lay1,
                unusedL, unusedW, unusedH,
                gapStatus: getGapStatus(unusedL, unusedW, unusedH),
                isMulti: true,
                carton2: { 
                  l: o2.l / 10, w: o2.w / 10, h: o2.h / 10, 
                  totalCartons: total2,
                  fitL: primarySlab.fitL, fitW: primarySlab.fitW, fitH: primarySlab.fitH,
                  layout: lay2,
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
            const layout = carton.layout || getBestLayoutForCarton(ori.l, ori.w, ori.h, count1);
            allResults.push({
              cartonL: ori.l / 10, cartonW: ori.w / 10, cartonH: ori.h / 10,
              fitL, fitW, fitH, totalCartons,
              totalCones,
              totalWeight: totalCones * cone.weight,
              layout,
              unusedL, unusedW, unusedH,
              gapStatus: getGapStatus(unusedL, unusedW, unusedH),
            });
          }
        }
      });
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
        // One is the main carton (at count1), the other can be smaller than count2
        const layouts1 = findAllLayouts(count1);
        const layouts2 = [];
        // Only try counts that are likely to fill gaps better (multiples or close to count2)
        // But the user said "even less than 18 (whatever feed in specs)"
        // To avoid total explosion, let's pick some reasonable counts
        for (let c = count2; c >= 1; c--) {
          layouts2.push(...findAllLayouts(c));
          if (layouts2.length > 100) break;
        }
        
        const candidates1 = layouts1.map(layout => ({
          l: cone.diameter * layout.cols,
          w: cone.diameter * layout.rows,
          h: cone.height * layout.layers,
          layout,
          total: count1
        })).filter(c => c.l <= 1000 && c.w <= 1000 && c.h <= 1000);

        const candidates2 = layouts2.map(layout => ({
          l: cone.diameter * layout.cols,
          w: cone.diameter * layout.rows,
          h: cone.height * layout.layers,
          layout,
          total: layout.total
        })).filter(c => c.l <= 1000 && c.w <= 1000 && c.h <= 1000);

        for (let i = 0; i < candidates1.length; i++) {
          for (let j = 0; j < candidates2.length; j++) {
            const oris1 = getOrientations(candidates1[i].l, candidates1[i].w, candidates1[i].h);
            const oris2 = getOrientations(candidates2[j].l, candidates2[j].w, candidates2[j].h);
            oris1.forEach(o1 => {
              if (o1.l > 1000 || o1.w > 1000 || o1.h > 1000) return;
              oris2.forEach(o2 => {
                if (o2.l > 1000 || o2.w > 1000 || o2.h > 1000) return;
                // Add layouts to oris
                const o1WithL = {...o1, layout: candidates1[i].layout};
                const o2WithL = {...o2, layout: candidates2[j].layout};
                
                // For Auto Multi, only call calculateMulti if it's potentially different
                if (count1 !== candidates2[j].total || o1.l !== o2.l || o1.w !== o2.w || o1.h !== o2.h) {
                   allResults.push(...calculateMulti(o1WithL, o2WithL, count1, candidates2[j].total));
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
