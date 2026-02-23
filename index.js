import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import * as XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';

const app = express();
const PORT = process.env.PORT || 3001;

// CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : ['http://localhost:5173', 'http://localhost:3000'];

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.includes('*')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json());

// Supabase Config (from Uster Quantum Dashboard.html)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Supabase Config for Long Term Report
const supabaseLongTermUrl = process.env.SUPABASE_LONG_TERM_URL;
const supabaseLongTermKey = process.env.SUPABASE_LONG_TERM_KEY;
const supabaseLongTerm = createClient(supabaseLongTermUrl, supabaseLongTermKey);

const formatDateToYYYYMMDD = (date) => {
  if (!date) return null;
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// Quality APIs using Long Term Supabase Source
app.get(['/api/quality/unique-article-numbers', '/api/long-term/unique-article-numbers'], async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 1) {
      return res.json([]);
    }

    let allArticles = new Set();
    let from = 0;
    const step = 1000;
    let hasMore = true;

    while (hasMore) {
      let query = supabaseLongTerm
        .from('uqe_data')
        .select('ArticleNumber')
        .ilike('ArticleNumber', `%${q}%`)
        .range(from, from + step - 1);
      
      const { data, error } = await query;
      if (error) throw error;

      if (!data || data.length === 0) {
        hasMore = false;
      } else {
        data.forEach(item => {
          if (item.ArticleNumber) {
            allArticles.add(item.ArticleNumber);
          }
        });
        
        if (data.length < step) {
          hasMore = false;
        } else {
          from += step;
        }
      }
    }
    
    const sortedArticles = [...allArticles].sort();
    res.json(sortedArticles);
  } catch (error) {
    console.error('Error fetching unique articles:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/quality/data-by-article', async (req, res) => {
  try {
    const { articleNumber } = req.query;
    if (!articleNumber) {
      return res.status(400).json({ error: 'Article number is required' });
    }

    let allData = [];
    let from = 0;
    const step = 1000;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await supabaseLongTerm
        .from('uqe_data')
        .select('*')
        .eq('ArticleNumber', articleNumber)
        .range(from, from + step - 1);

      if (error) throw error;
      if (!data || data.length === 0) {
        hasMore = false;
      } else {
        allData = allData.concat(data);
        if (data.length < step) {
          hasMore = false;
        } else {
          from += step;
        }
      }
    }

    res.json(allData);
  } catch (error) {
    console.error('Error in /api/quality/data-by-article:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get(['/api/quality/data', '/api/long-term/data'], async (req, res) => {
  try {
    const { startDate, endDate, lotId, articles, unit } = req.query;

    // Check if at least one filter is provided
    const hasDateFilter = startDate && endDate;
    const hasLotFilter = lotId && lotId.trim().length > 0;
    const hasArticleFilter = articles && articles.trim().length > 0;
    const hasUnitFilter = unit && unit.trim().length > 0;

    if (!hasDateFilter && !hasLotFilter && !hasArticleFilter && !hasUnitFilter) {
      return res.status(400).json({ error: 'At least one filter (Date Range, Lot ID, Articles, or Unit) is required' });
    }

    let allData = [];
    let from = 0;
    const step = 1000;
    let hasMore = true;

    while (hasMore) {
      let query = supabaseLongTerm.from('uqe_data').select('*');
      
      // Apply filters
      if (hasDateFilter) {
        // Use 'T23:59:59' to make the endDate inclusive of the whole day
        query = query.gte('ShiftStartTime', `${startDate}T00:00:00`).lte('ShiftStartTime', `${endDate}T23:59:59`);
      }

      if (hasLotFilter) {
        const lots = lotId.split(',').map(l => l.trim()).filter(Boolean);
        if (lots.length > 0) query = query.in('LotID', lots);
      }

      if (hasArticleFilter) {
        const artList = articles.split(',').map(a => a.trim()).filter(Boolean);
        if (artList.length > 0) query = query.in('ArticleNumber', artList);
      }

      if (hasUnitFilter) {
        query = query.eq('MillUnit', unit.trim());
      }

      // Add range for pagination
      query = query.range(from, from + step - 1);

      const { data, error } = await query;
      if (error) throw error;

      if (!data || data.length === 0) {
        hasMore = false;
      } else {
        allData = allData.concat(data);
        if (data.length < step) {
          hasMore = false;
        } else {
          from += step;
        }
      }
    }

    res.json(allData);
  } catch (error) {
    console.error('Error in long-term data API:', error);
    res.status(500).json({ error: error.message });
  }
});

// Quantum Dashboard Data (Supabase Storage)
let cachedUnitsData = {}; // Store raw JSON data for each unit
let cachedLiveData = null;
let lastFetchTime = null;

const fetchAllUnitsData = async () => {
  const units = ['U-1', 'U-2', 'U-3', 'U-4', 'U-5', 'U-6'];
  const unitMap = {
    'U-1': '1.xlsx', 'U-2': '2.xlsx', 'U-3': '3.xlsx',
    'U-4': '4.xlsx', 'U-5': '5.xlsx', 'U-6': '6.xlsx'
  };

  const newData = {};
  await Promise.all(units.map(async (unit) => {
    try {
      const { data, error } = await supabase.storage.from('uqe').download(unitMap[unit]);
      if (error) throw error;
      const arrayBuffer = await data.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer, { type: 'array', cellDates: true });
      const sheetName = workbook.SheetNames[0];
      newData[unit] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
    } catch (err) {
      console.error(`Error caching ${unit}:`, err.message);
      newData[unit] = cachedUnitsData[unit] || []; // Keep old data on error
    }
  }));
  cachedUnitsData = newData;
};

const getQuantumData = async (dateFilter = null, shiftFilter = null, unitFilter = null, machineFilter = null, isDashboard = false) => {
  const units = unitFilter ? [unitFilter] : ['U-1', 'U-2', 'U-3', 'U-4', 'U-5', 'U-6'];
  
  // If no date or shift filter provided, find the latest available across all relevant units
  let targetDateStr = dateFilter;
  let targetShift = shiftFilter === 'all' ? null : shiftFilter;
  let targetLatestShift = 'All';

  if (!targetDateStr || (!targetShift && shiftFilter !== 'all')) {
    let allRecords = [];
    units.forEach(u => {
      if (cachedUnitsData[u]) allRecords = allRecords.concat(cachedUnitsData[u]);
    });

    if (allRecords.length > 0) {
      const availableDates = [...new Set(allRecords.map(item => {
        const dateVal = item.ShiftStartTime || item.shiftstarttime || item.Date;
        if (!dateVal) return null;
        const d = new Date(dateVal);
        return isNaN(d.getTime()) ? null : formatDateToYYYYMMDD(d);
      }))].filter(Boolean).sort().reverse();

      if (!targetDateStr && availableDates.length > 0) {
        // Default to latest date for Home, Yesterday for Dashboard
        targetDateStr = isDashboard ? (availableDates[1] || availableDates[0]) : availableDates[0];
      }

      if (targetDateStr) {
        const shiftsForDate = [...new Set(allRecords
          .filter(item => {
            const dateVal = item.ShiftStartTime || item.shiftstarttime || item.Date;
            const d = new Date(dateVal);
            return formatDateToYYYYMMDD(d) === targetDateStr;
          })
          .map(item => item.ShiftNumber || item.Shift || item.shiftnumber || item.shift)
        )].filter(Boolean).sort((a, b) => b - a); // Descending for latest shift

        const latestShiftForDate = shiftsForDate[0] || 'All';

        if (!targetShift && shiftFilter !== 'all') {
          targetShift = latestShiftForDate;
        }
        
        // We'll attach this latestShiftForDate to each unit's response
        targetLatestShift = latestShiftForDate;
      }
    }
  }

  try {
    const results = units.map((unit) => {
      const jsonData = cachedUnitsData[unit] || [];

      if (jsonData.length === 0) {
        return { unit, yarnFaults: 'N/A', shiftStartTime: null, articles: [], latestShift: 'All' };
      }

      const records = jsonData.filter(item => {
        const dateVal = item.ShiftStartTime || item.shiftstarttime || item.Date;
        if (!dateVal) return false;
        const d = new Date(dateVal);
        if (isNaN(d.getTime())) return false;
        const itemDateStr = formatDateToYYYYMMDD(d);
        
        if (targetDateStr && itemDateStr !== targetDateStr) return false;
        
        if (targetShift) {
          const rowShift = item.ShiftNumber || item.Shift || item.shiftnumber || item.shift;
          if (String(rowShift) !== String(targetShift)) return false;
        }

        if (machineFilter) {
          const rowMach = item.MachineName || item.machinename || item.Machine || item.machine;
          if (String(rowMach) !== String(machineFilter)) return false;
        }

        const yarnLength = Number(item.YarnLength || item.yarnlength) || 0;
        if (yarnLength < 300) return false;
        
        return true;
      });

      let avgYarnFaults = 0;
      let totalAlarms = 0;
      let alarmsPer1000km = 0;
      let alarmBreakdown = {};
      let totalCuts = 0;
      let cutsPer100km = 0;
      
      const alarmColumns = [
        'NSABlks', 'LABlks', 'TABlks', 'CABlks', 'CCABlks', 
        'FABlks', 'PPABlks', 'PFABlks', 'CVpABlks', 'HpABlks', 'CMTABlks'
      ];

      const cutColumns = [
        'YarnFaults', 'YarnJoints', 'YarnBreaks', 'NCuts', 'SCuts', 'LCuts', 'TCuts', 'FDCuts', 'PPCuts'
      ];

      const qualityColumns = [
        'Thin50', 'Thick50', 'Nep200', 'CVAvg', 'HAvg', 'IPI', 'HSIPI'
      ];

      // Initialize breakdown
      alarmColumns.forEach(col => alarmBreakdown[col] = 0);
      
      // Article-wise data
      const articleMap = {};
      const unitCuts = {};
      const unitQuality = {};
      cutColumns.forEach(col => unitCuts[col] = 0);
      qualityColumns.forEach(col => unitQuality[col] = { sum: 0, count: 0, refLength: 0 });

      if (records.length > 0) {
        const totalFaults = records.reduce((acc, curr) => acc + (Number(curr.YarnFaults || curr.yarnfaults) || 0), 0);
        const totalLength = records.reduce((acc, curr) => acc + (Number(curr.YarnLength || curr.yarnlength) || 0), 0);
        
        if (totalLength > 0) {
          avgYarnFaults = ((totalFaults / totalLength) * 100).toFixed(2);
        }

        totalAlarms = records.reduce((acc, curr) => {
          let rowAlarms = 0;
          alarmColumns.forEach(col => {
            const actualCol = Object.keys(curr).find(k => k.toLowerCase() === col.toLowerCase());
            const val = Number(curr[actualCol || col]) || 0;
            alarmBreakdown[col] += val;
            rowAlarms += val;
          });
          return acc + rowAlarms;
        }, 0);

        totalCuts = records.reduce((acc, curr) => {
          const cutVal = curr.Cuts || curr.cuts || curr.TotalCuts || curr.totalcuts || 0;
          return acc + (Number(cutVal) || 0);
        }, 0);

        if (totalLength > 0) {
          alarmsPer1000km = ((totalAlarms / totalLength) * 1000).toFixed(2);
          cutsPer100km = ((totalCuts / totalLength) * 100).toFixed(2);
        }

        // Sum up cuts and quality for the whole unit
        records.forEach(curr => {
          cutColumns.forEach(col => {
            const actualCol = Object.keys(curr).find(k => k.toLowerCase() === col.toLowerCase());
            unitCuts[col] += Number(curr[actualCol || col]) || 0;
          });

          const ipRefLength = Number(curr.IPRefLength || curr.ipreflength || curr.RefLength || 0) || 0;
          qualityColumns.forEach(col => {
            let val = 0;
            if (col === 'IPI') {
              val = (Number(curr.Thin50 || curr.thin50 || 0)) + (Number(curr.Thick50 || curr.thick50 || 0)) + (Number(curr.Nep200 || curr.nep200 || 0));
            } else if (col === 'HSIPI') {
              val = (Number(curr.Thin40 || curr.thin40 || 0)) + (Number(curr.Thick35 || curr.thick35 || 0)) + (Number(curr.Nep140 || curr.nep140 || 0));
            } else {
              const actualCol = Object.keys(curr).find(k => k.toLowerCase() === col.toLowerCase());
              val = Number(curr[actualCol || col]) || 0;
            }
            unitQuality[col].sum += val;
            unitQuality[col].count += 1;
            unitQuality[col].refLength += ipRefLength;
          });
        });

        // Group by ArticleNumber and MachineName
        records.forEach(curr => {
          const artNum = curr.ArticleNumber || curr.articlenumber || 'Unknown';
          const machName = curr.MachineName || curr.machinename || curr.Machine || curr.machine || 'Unknown';

          if (!articleMap[artNum]) {
            articleMap[artNum] = {
              articleNumber: artNum,
              yarnLength: 0,
              cuts: {},
              quality: {},
              totalAlarms: 0,
              alarmBreakdown: {},
              machines: {}
            };
            cutColumns.forEach(col => articleMap[artNum].cuts[col] = 0);
            qualityColumns.forEach(col => articleMap[artNum].quality[col] = { sum: 0, count: 0, refLength: 0 });
            alarmColumns.forEach(col => articleMap[artNum].alarmBreakdown[col] = 0);
          }
          
          const ipRefLength = Number(curr.IPRefLength || curr.ipreflength || curr.RefLength || 0) || 0;
          articleMap[artNum].yarnLength += Number(curr.YarnLength || curr.yarnlength) || 0;
          cutColumns.forEach(col => {
            const actualCol = Object.keys(curr).find(k => k.toLowerCase() === col.toLowerCase());
            articleMap[artNum].cuts[col] += Number(curr[actualCol || col]) || 0;
          });

          qualityColumns.forEach(col => {
            let val = 0;
            if (col === 'IPI') {
              val = (Number(curr.Thin50 || curr.thin50 || 0)) + (Number(curr.Thick50 || curr.thick50 || 0)) + (Number(curr.Nep200 || curr.nep200 || 0));
            } else if (col === 'HSIPI') {
              val = (Number(curr.Thin40 || curr.thin40 || 0)) + (Number(curr.Thick35 || curr.thick35 || 0)) + (Number(curr.Nep140 || curr.nep140 || 0));
            } else {
              const actualCol = Object.keys(curr).find(k => k.toLowerCase() === col.toLowerCase());
              val = Number(curr[actualCol || col]) || 0;
            }
            articleMap[artNum].quality[col].sum += val;
            articleMap[artNum].quality[col].count += 1;
            articleMap[artNum].quality[col].refLength += ipRefLength;
          });

          alarmColumns.forEach(col => {
            const actualCol = Object.keys(curr).find(k => k.toLowerCase() === col.toLowerCase());
            const val = Number(curr[actualCol || col]) || 0;
            articleMap[artNum].alarmBreakdown[col] += val;
            articleMap[artNum].totalAlarms += val;
          });

          if (!articleMap[artNum].machines[machName]) {
            articleMap[artNum].machines[machName] = {
              machineName: machName,
              yarnLength: 0,
              cuts: {},
              quality: {},
              totalAlarms: 0,
              alarmBreakdown: {}
            };
            cutColumns.forEach(col => articleMap[artNum].machines[machName].cuts[col] = 0);
            qualityColumns.forEach(col => articleMap[artNum].machines[machName].quality[col] = { sum: 0, count: 0, refLength: 0 });
            alarmColumns.forEach(col => articleMap[artNum].machines[machName].alarmBreakdown[col] = 0);
          }

          articleMap[artNum].machines[machName].yarnLength += Number(curr.YarnLength || curr.yarnlength) || 0;
          cutColumns.forEach(col => {
            const actualCol = Object.keys(curr).find(k => k.toLowerCase() === col.toLowerCase());
            articleMap[artNum].machines[machName].cuts[col] += Number(curr[actualCol || col]) || 0;
          });

          qualityColumns.forEach(col => {
            let val = 0;
            if (col === 'IPI') {
              val = (Number(curr.Thin50 || curr.thin50 || 0)) + (Number(curr.Thick50 || curr.thick50 || 0)) + (Number(curr.Nep200 || curr.nep200 || 0));
            } else if (col === 'HSIPI') {
              val = (Number(curr.Thin40 || curr.thin40 || 0)) + (Number(curr.Thick35 || curr.thick35 || 0)) + (Number(curr.Nep140 || curr.nep140 || 0));
            } else {
              const actualCol = Object.keys(curr).find(k => k.toLowerCase() === col.toLowerCase());
              val = Number(curr[actualCol || col]) || 0;
            }
            articleMap[artNum].machines[machName].quality[col].sum += val;
            articleMap[artNum].machines[machName].quality[col].count += 1;
            articleMap[artNum].machines[machName].quality[col].refLength += ipRefLength;
          });

          alarmColumns.forEach(col => {
            const actualCol = Object.keys(curr).find(k => k.toLowerCase() === col.toLowerCase());
            const val = Number(curr[actualCol || col]) || 0;
            articleMap[artNum].machines[machName].alarmBreakdown[col] += val;
            articleMap[artNum].machines[machName].totalAlarms += val;
          });
        });
      }

      const articles = Object.values(articleMap).map(art => {
        const artCutsPer100km = {};
        cutColumns.forEach(col => {
          artCutsPer100km[col] = art.yarnLength > 0 ? ((art.cuts[col] / art.yarnLength) * 100).toFixed(2) : '0.00';
        });

        const artQualityVals = {};
        qualityColumns.forEach(col => {
          const stats = art.quality[col];
          if (col === 'CVAvg' || col === 'HAvg') {
            artQualityVals[col] = stats.count > 0 ? (stats.sum / stats.count).toFixed(2) : '0.00';
          } else {
            artQualityVals[col] = stats.refLength > 0 ? (stats.sum / stats.refLength).toFixed(2) : '0.00';
          }
        });

        const machines = Object.values(art.machines).map(mach => {
          const machCutsPer100km = {};
          cutColumns.forEach(col => {
            machCutsPer100km[col] = mach.yarnLength > 0 ? ((mach.cuts[col] / mach.yarnLength) * 100).toFixed(2) : '0.00';
          });

          const machQualityVals = {};
          qualityColumns.forEach(col => {
            const stats = mach.quality[col];
            if (col === 'CVAvg' || col === 'HAvg') {
              machQualityVals[col] = stats.count > 0 ? (stats.sum / stats.count).toFixed(2) : '0.00';
            } else {
              machQualityVals[col] = stats.refLength > 0 ? (stats.sum / stats.refLength).toFixed(2) : '0.00';
            }
          });

          return {
            machineName: mach.machineName,
            ...machCutsPer100km,
            ...machQualityVals,
            totalAlarms: mach.totalAlarms,
            alarmBreakdown: mach.alarmBreakdown
          };
        });

        return {
          articleNumber: art.articleNumber,
          ...artCutsPer100km,
          ...artQualityVals,
          totalAlarms: art.totalAlarms,
          alarmBreakdown: art.alarmBreakdown,
          machines
        };
      });

      const unitCutsPer100km = {};
      cutColumns.forEach(col => {
        const unitTotalLength = records.reduce((acc, curr) => acc + (Number(curr.YarnLength || curr.yarnlength) || 0), 0);
        unitCutsPer100km[col] = unitTotalLength > 0 ? ((unitCuts[col] / unitTotalLength) * 100).toFixed(2) : '0.00';
      });

      const unitQualityVals = {};
      qualityColumns.forEach(col => {
        const stats = unitQuality[col];
        if (col === 'CVAvg' || col === 'HAvg') {
          unitQualityVals[col] = stats.count > 0 ? (stats.sum / stats.count).toFixed(2) : '0.00';
        } else {
          unitQualityVals[col] = stats.refLength > 0 ? (stats.sum / stats.refLength).toFixed(2) : '0.00';
        }
      });

      return {
        unit,
        yarnFaults: avgYarnFaults,
        totalAlarms: totalAlarms,
        alarmsPer1000km: alarmsPer1000km,
        alarmBreakdown,
        totalCuts: totalCuts,
        cutsPer100km: cutsPer100km,
        unitCuts: unitCutsPer100km,
        unitQuality: unitQualityVals,
        shiftStartTime: targetDateStr,
        shiftNumber: targetShift || 'All',
        latestShift: targetLatestShift,
        articles
      };
    });

    return results;
  } catch (error) {
    console.error("Failed to process quantum data:", error.message);
    return [];
  }
};

const updateQuantumLiveData = async () => {
  await fetchAllUnitsData();
  const results = await getQuantumData();
  cachedLiveData = results;
  lastFetchTime = new Date();
};

// Initial fetch and start polling
updateQuantumLiveData();
setInterval(updateQuantumLiveData, 1800000); // Sync every 30 minutes

app.get('/api/quantum/live', async (req, res) => {
  const { date, shift, unit, machine, mode } = req.query;
  const isDashboard = mode === 'dashboard';
  
  if (date || shift || unit || machine || isDashboard) {
    const data = await getQuantumData(date, shift, unit, machine, isDashboard);
    res.json(data);
  } else if (cachedLiveData) {
    res.json(cachedLiveData);
  } else {
    await updateQuantumLiveData();
    res.json(cachedLiveData || []);
  }
});

app.get('/api/quantum/available-filters', async (req, res) => {
  try {
    const { unit } = req.query;
    if (Object.keys(cachedUnitsData).length === 0) {
      console.log("Filters requested but cache empty, fetching now...");
      await fetchAllUnitsData();
    }

    let allRecords;
    if (unit && cachedUnitsData[unit]) {
      allRecords = cachedUnitsData[unit];
    } else {
      allRecords = Object.values(cachedUnitsData).flat();
    }


   
    const dates = [...new Set(allRecords.map(item => {
      const dateVal = item.ShiftStartTime || item.shiftstarttime || item.Date;
      if (!dateVal) return null;
      const d = new Date(dateVal);
      if (isNaN(d.getTime())) return null;
      return formatDateToYYYYMMDD(d);
    }))].filter(Boolean).sort().reverse();

    const shifts = [...new Set(allRecords.map(item => item.ShiftNumber || item.Shift || item.shiftnumber || item.shift))].filter(Boolean).sort();
    const machines = [...new Set(allRecords.map(item => item.MachineName || item.machinename || item.Machine || item.machine))].filter(Boolean).sort();
    const articles = [...new Set(allRecords.map(item => item.ArticleNumber || item.articlenumber))].filter(Boolean).sort();
    const articleNames = [...new Set(allRecords.map(item => item.ArticleName || item.articlename || item.Article || item.article))].filter(Boolean).sort();
    const lotIds = [...new Set(allRecords.map(item => item.LotID || item.lotid || item.LotId))].filter(Boolean).sort();
    const units = ['U-1', 'U-2', 'U-3', 'U-4', 'U-5', 'U-6'];

   res.json({ dates, shifts, units, machines, articles, articleNames, lotIds });
  } catch (error) {
    console.error("Error in available-filters:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/quantum/data/:unit', async (req, res) => {
  const { unit } = req.params;
  const unitMap = {
    'U-1': '1.xlsx',
    'U-2': '2.xlsx',
    'U-3': '3.xlsx',
    'U-4': '4.xlsx',
    'U-5': '5.xlsx',
    'U-6': '6.xlsx'
  };

  const fileName = unitMap[unit];
  if (!fileName) return res.status(400).json({ error: 'Invalid unit' });

  try {
    const { data, error } = await supabase.storage.from('uqe').download(fileName);
    if (error) throw error;

    const arrayBuffer = await data.arrayBuffer();
    const workbook = XLSX.read(arrayBuffer, { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    const jsonData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

    res.json(jsonData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/quantum/trend', async (req, res) => {
  const { group, firstColumn, parameter, unit: unitFilter, filterValues } = req.query;
  
  if (!firstColumn || !parameter) {
    return res.status(400).json({ error: 'firstColumn and parameter are required' });
  }

  let filterValuesArray = null;
  if (filterValues) {
    filterValuesArray = Array.isArray(filterValues) ? filterValues : filterValues.split(',');
  }

  try {
    if (Object.keys(cachedUnitsData).length === 0) {
      await fetchAllUnitsData();
    }

    const trendMap = {}; // { date: { label: { sum, refLength, yarnLength, count } } }
    const labels = new Set();
    const dates = new Set();

    Object.entries(cachedUnitsData).forEach(([unit, records]) => {
      if (unitFilter && unit !== unitFilter) return;

      records.forEach(item => {
        const dateVal = item.ShiftStartTime || item.shiftstarttime || item.Date;
        if (!dateVal) return;
        const d = new Date(dateVal);
        if (isNaN(d.getTime())) return;
        
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const dateStr = `${year}-${month}-${day}`;

        let label = 'Unknown';
        if (firstColumn === 'unit') label = unit;
        else if (firstColumn === 'articlename') label = item.ArticleName || item.articlename || item.Article || item.article || 'Unknown';
        else if (firstColumn === 'articlenumber') label = item.ArticleNumber || item.articlenumber || 'Unknown';
        else if (firstColumn === 'lotid') label = item.LotID || item.lotid || item.LotId || 'Unknown';
        else if (firstColumn === 'machinename') label = item.MachineName || item.machinename || item.Machine || item.machine || 'Unknown';

        if (filterValuesArray && !filterValuesArray.includes(label)) return;

        labels.add(label);
        dates.add(dateStr);

        // Find parameter value
        let val = 0;
        if (parameter === 'IPI') {
          val = (Number(item.Thin50 || item.thin50 || 0)) + 
                (Number(item.Thick50 || item.thick50 || 0)) + 
                (Number(item.Nep200 || item.nep200 || 0));
        } else if (parameter === 'HSIPI') {
          val = (Number(item.Thin40 || item.thin40 || 0)) + 
                (Number(item.Thick35 || item.thick35 || 0)) + 
                (Number(item.Nep140 || item.nep140 || 0));
        } else if (parameter === 'totalAlarms') {
          const alarmColumns = [
            'NSABlks', 'LABlks', 'TABlks', 'CABlks', 'CCABlks', 
            'FABlks', 'PPABlks', 'PFABlks', 'CVpABlks', 'HpABlks', 'CMTABlks'
          ];
          val = alarmColumns.reduce((acc, col) => {
            const actualCol = Object.keys(item).find(k => k.toLowerCase() === col.toLowerCase());
            return acc + (Number(item[actualCol || col]) || 0);
          }, 0);
        } else {
          const targetParam = parameter.toLowerCase().replace(/\s/g, '');
          const paramKey = Object.keys(item).find(k => k.toLowerCase().replace(/\s/g, '') === targetParam);
          val = Number(item[paramKey || parameter]) || 0;
        }

        // Find denominators
        const ipRefLength = Number(item.IPRefLength || item.ipreflength || item.RefLength || 0) || 0;
        const yarnLength = Number(item.YarnLength || item.yarnlength || 0) || 0;
        const machineName = item.MachineName || item.machinename || item.Machine || item.machine || 'Unknown';

        if (!trendMap[dateStr]) trendMap[dateStr] = {};
        if (!trendMap[dateStr][label]) {
          trendMap[dateStr][label] = { sum: 0, refLength: 0, yarnLength: 0, count: 0, machines: {} };
        }
        
        trendMap[dateStr][label].sum += val;
        trendMap[dateStr][label].refLength += ipRefLength;
        trendMap[dateStr][label].yarnLength += yarnLength;
        trendMap[dateStr][label].count += 1;

        if (!trendMap[dateStr][label].machines[machineName]) {
          trendMap[dateStr][label].machines[machineName] = { sum: 0, refLength: 0, yarnLength: 0, count: 0 };
        }
        trendMap[dateStr][label].machines[machineName].sum += val;
        trendMap[dateStr][label].machines[machineName].refLength += ipRefLength;
        trendMap[dateStr][label].machines[machineName].yarnLength += yarnLength;
        trendMap[dateStr][label].machines[machineName].count += 1;
      });
    });

    const sortedDates = Array.from(dates).sort((a, b) => a.localeCompare(b));
    const labelMachineMap = {}; // { label: Set(machines) }

    const result = sortedDates.map(date => {
      const row = { date };
      Object.keys(trendMap[date]).forEach(label => {
        const stats = trendMap[date][label];
        
        const calculateFinal = (s) => {
          let finalVal = 0;
          if (group === 'quality') {
            if (parameter === 'CVAvg' || parameter === 'HAvg') {
              finalVal = s.count > 0 ? (s.sum / s.count).toFixed(2) : "0.00";
            } else {
              finalVal = s.refLength > 0 ? (s.sum / s.refLength).toFixed(2) : "0.00";
            }
          } else if (group === 'cuts' || group === 'cmt') {
            finalVal = s.yarnLength > 0 ? ((s.sum / s.yarnLength) * 100).toFixed(2) : "0.00";
          } else if (group === 'alarms') {
            finalVal = s.sum;
          } else {
            finalVal = s.sum;
          }
          return finalVal;
        };

        row[label] = calculateFinal(stats);

        // Calculate for machines
        if (!labelMachineMap[label]) labelMachineMap[label] = new Set();
        if (!row.machines) row.machines = {};
        row.machines[label] = {};

        Object.keys(stats.machines).forEach(m => {
          labelMachineMap[label].add(m);
          row.machines[label][m] = calculateFinal(stats.machines[m]);
        });
      });
      return row;
    });

    // Structure drillDownData: { label: { labels: [machines], data: [ {date, mach1, mach2} ] } }
    const drillDownData = {};
    Object.keys(labelMachineMap).forEach(label => {
      const machines = Array.from(labelMachineMap[label]).sort();
      const machineTrend = sortedDates.map(date => {
        const dRow = { date };
        const dayStats = trendMap[date][label];
        machines.forEach(m => {
          if (dayStats && dayStats.machines[m]) {
            const s = dayStats.machines[m];
            let val = 0;
            if (group === 'quality') {
              if (parameter === 'CVAvg' || parameter === 'HAvg') {
                val = s.count > 0 ? (s.sum / s.count).toFixed(2) : "0.00";
              } else {
                val = s.refLength > 0 ? (s.sum / s.refLength).toFixed(2) : "0.00";
              }
            } else if (group === 'cuts' || group === 'cmt') {
              val = s.yarnLength > 0 ? ((s.sum / s.yarnLength) * 100).toFixed(2) : "0.00";
            } else if (group === 'alarms') {
              val = s.sum;
            } else {
              val = s.sum;
            }
            dRow[m] = val;
          } else {
            dRow[m] = undefined;
          }
        });
        return dRow;
      });
      drillDownData[label] = {
        labels: machines,
        data: machineTrend
      };
    });

    res.json({
      data: result,
      labels: Array.from(labels).sort(),
      dates: sortedDates,
      drillDownData: drillDownData
    });
  } catch (error) {
    console.error("Trend API Error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }

    const { data, error } = await supabaseLongTerm
      .from('login_details')
      .select('password')
      .eq('password', password.trim()); // Added trim just in case

    if (error) {
      console.error('Supabase Query Error:', error);
      return res.status(401).json({ 
        error: 'Authentication failed', 
        details: error.message
      });
    }

    if (!data || data.length === 0) {
  
      // Debug: Check what IS in the table
      const { data: allRows } = await supabaseLongTerm.from('login_details').select('*').limit(5);
      
      const { data: primaryDbRows } = await supabase.from('login_details').select('*').limit(5);

      return res.status(401).json({ error: 'Incorrect password' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Server Login Exception:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/change-password', async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: 'Both old and new passwords are required' });
    }

    // Verify old password
    const { data: verifyData, error: verifyError } = await supabaseLongTerm
      .from('login_details')
      .select('id, password')
      .eq('password', oldPassword.trim());

    if (verifyError || !verifyData || verifyData.length === 0) {
      return res.status(401).json({ error: 'Incorrect old password' });
    }

    // Update to new password
    // Note: Assuming we update all entries or the specific one. 
    // Since login logic checks if ANY entry matches, we should probably update all or the first one.
    // Let's update the specific entry found.
    const entryId = verifyData[0].id;
    const { error: updateError } = await supabaseLongTerm
      .from('login_details')
      .update({ password: newPassword.trim() })
      .eq('id', entryId);

    if (updateError) {
      throw updateError;
    }

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (error) {
    console.error('Change Password Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/restart-server', async (req, res) => {
  try {
    const serviceId = 'srv-d68887ur433s73cg6q1g';
    const apiKey = process.env.RENDER_API_KEY;

    if (!apiKey || apiKey === 'your_render_api_key_here') {
      return res.status(500).json({ error: 'Render API key not configured' });
    }

    const response = await fetch(`https://api.render.com/v1/services/${serviceId}/restart`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `Failed to restart server: ${response.statusText}`);
    }

    res.json({ success: true, message: 'Server restart triggered successfully' });
  } catch (error) {
    console.error('Restart Server Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
