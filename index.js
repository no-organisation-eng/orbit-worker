import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ⭐ NEW: Import Whisper from Transformers
import { pipeline } from "@xenova/transformers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// ⭐ Initialize Whisper (small model)
let transcriber;
(async () => {
  transcriber = await pipeline("automatic-speech-recognition", "Xenova/whisper-small");
  console.log("Whisper model initialized");
})();

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Gemini endpoint
const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";

app.post("/process", async (req, res) => {
  try {
    const { entry_id, audio_url, user_id } = req.body;

    if (!entry_id || !audio_url) {
      return res.status(400).json({ error: "entry_id and audio_url required" });
    }

    console.log(`Processing entry ${entry_id}...`);

    // 1️⃣ Download audio
    console.log("Downloading audio...");
    const audioRes = await fetch(audio_url);

    if (!audioRes.ok) {
      throw new Error(`Failed to download audio: ${audioRes.status}`);
    }

    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    const tempPath = path.join(__dirname, `temp_${entry_id}.webm`);
    fs.writeFileSync(tempPath, audioBuffer);

    // 2️⃣ Transcribe with Whisper (Xenova)
    console.log("Transcribing with Whisper...");
    const result = await transcriber(tempPath, {
      chunk_length_s: 30,
    });

    const transcript = result.text;

    fs.unlinkSync(tempPath);

    console.log("Transcript:", transcript.slice(0, 120) + "...");

    // 3️⃣ Summarize with Gemini
    console.log("Generating summary...");
    const geminiRes = await fetch(
      `${GEMINI_API_URL}?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `Summarize this journal entry:\n\n${transcript}`,
                },
              ],
            },
          ],
        }),
      }
    );

    const geminiData = await geminiRes.json();
    const summary =
      geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ||
      transcript.slice(0, 200);

    console.log("Summary:", summary);

    // 4️⃣ Update Supabase
    console.log("Updating Supabase...");
    const { error: updateError } = await supabase
      .from("entries")
      .update({
        transcript,
        summary,
        status: "completed",
      })
      .eq("id", entry_id);

    if (updateError) throw updateError;

    res.json({
      success: true,
      transcript_length: transcript.length,
      summary_length: summary.length,
    });
  } catch (err) {
    console.error("Processing error:", err);

    try {
      await supabase
        .from("entries")
        .update({ status: "failed" })
        .eq("id", req.body.entry_id);
    } catch {}

    res
      .status(500)
      .json({ error: "processing_failed", details: err.message });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 ORBIT Worker running on port ${PORT}`));
