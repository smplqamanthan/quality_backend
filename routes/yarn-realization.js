import express from "express";
import { supabase } from "../supabase/client.js";

const router = express.Router();

router.get("/yarn-realization", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("yarn_realization")
      .select("*")
      .order("date", { ascending: false });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error("Yarn realization fetch error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put("/yarn-realization/:id", async (req, res) => {
  const { id } = req.params;
  const updateData = req.body;
  
  try {
    const { data, error } = await supabase
      .from("yarn_realization")
      .update(updateData)
      .eq("id", id)
      .select();

    if (error) throw error;
    res.json({ success: true, data: data[0] });
  } catch (err) {
    console.error("Yarn realization update error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/yarn-realization", async (req, res) => {
  const insertData = req.body;
  
  try {
    const { data, error } = await supabase
      .from("yarn_realization")
      .insert(insertData)
      .select();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error("Yarn realization insert error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
