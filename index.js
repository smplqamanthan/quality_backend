import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { supabase } from "./supabase/client.js";
import complaintRoutes from "./routes/complaints.js";
import layoutRoutes from "./routes/layouts.js";
import utilRoutes from "./routes/utils.js";
import dispatchRoutes from "./routes/dispatch.js";
import masterRoutes from "./routes/master.js";
import dispatchResultsRoutes from "./routes/dispatch-results.js";
import cottonRoutes from "./routes/cotton.js";
import authRoutes from "./routes/auth.js";
import yarnRealizationRoutes from "./routes/yarn-realization.js";
import stuffingRoutes from "./routes/stuffing.js";

dotenv.config();

const app = express();

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || "*"
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Anti-caching middleware
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surge-Control', 'no-store');
  next();
});

// Health check route
app.get("/health", (req, res) => {
  res.json({ status: "Backend is running" });
});

// Restart service route
app.post("/api/restart-service", async (req, res) => {
  const serviceId = process.env.RENDER_SERVICE_ID;
  const apiKey = process.env.RENDER_API_KEY;

  if (!serviceId || !apiKey) {
    return res.status(500).json({ success: false, error: "Render credentials not configured" });
  }

  try {
    const response = await fetch(`https://api.render.com/v1/services/${serviceId}/deploys`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      res.json({ success: true, message: "Restart triggered successfully", data });
    } else {
      let errorMessage = "Failed to trigger restart";
      try {
        const errorData = await response.json();
        errorMessage = errorData.message || errorMessage;
      } catch (e) {
        errorMessage = await response.text() || errorMessage;
      }
      res.status(response.status).json({ success: false, error: errorMessage });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Supabase connectivity test
app.get("/supabase-test", async (req, res) => {
  const { data, error } = await supabase
    .from("information_schema.tables")
    .select("table_name")
    .limit(5);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true, data });
});

// Use modular routes
const apiRouter = express.Router();
apiRouter.use(complaintRoutes);
apiRouter.use(layoutRoutes);
apiRouter.use(utilRoutes);
apiRouter.use(dispatchRoutes);
apiRouter.use(masterRoutes);
apiRouter.use(dispatchResultsRoutes);
apiRouter.use(cottonRoutes);
apiRouter.use(authRoutes);
apiRouter.use(yarnRealizationRoutes);
apiRouter.use(stuffingRoutes);

app.use("/api", apiRouter);

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
