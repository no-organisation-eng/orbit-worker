import express from "express";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import whisper from "whisper-node";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Gemini API endpoint
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";

app.post("/process", async (req, res) => {
  try {
    const { entry_id, audio_url, user_id } = req.body;

    if (!entry_id || !audio_url) {
      return res.status(400).json({ error: "entry_id and audio_url required" });
    }

    console.log(`Processing entry ${entry_id}...`);

    // 1️⃣ Download audio file
    console.log("Downloading audio...");
    const audioRes = await fetch(audio_url);
    if (!audioRes.ok) {
      throw new Error(`Failed to download audio: ${audioRes.status}`);
    }

    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
    
    // Save temporarily
    const tempPath = path.join(__dirname, `temp_${entry_id}.webm`);
    fs.writeFileSync(tempPath, audioBuffer);

    // 2️⃣ Transcribe with local Whisper (correct usage)
    console.log("Transcribing with Whisper...");
    const transcript = await whisper(tempPath, {
      modelName: "base.en",
      whisperOptions: {
        language: "en"
      }
    });

    // Clean up temp file
    fs.unlinkSync(tempPath);

    console.log("Transcript:", JSON.stringify(transcript).slice(0, 200) + "...");

    // 3️⃣ Generate summary using Gemini
    console.log("Generating summary with Gemini...");
    
    // Extract text from whisper result
    const transcriptText = Array.isArray(transcript) 
      ? transcript.map(t => t.speech || t.text || '').join(" ")
      : (typeof transcript === 'string' ? transcript : JSON.stringify(transcript));

    const geminiRes = await fetch(`${GEMINI_API_URL}?key=${process.env.GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `Analyze this journal entry and provide:
1. A brief summary (2-3 sentences)
2. 3-5 key insights or themes

Transcript:
${transcriptText}

Format your response as JSON:
{
  "summary": "...",
  "insights": ["insight1", "insight2", ...]
}`
          }]
        }]
      })
    });

    if (!geminiRes.ok) {
      const errorText = await geminiRes.text();
      console.error("Gemini error:", errorText);
      throw new Error(`Gemini API failed: ${geminiRes.status}`);
    }

    const geminiData = await geminiRes.json();
    const responseText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    
    // Parse JSON response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { 
      summary: transcriptText.slice(0, 200), 
      insights: [] 
    };

    console.log("Summary:", parsed.summary);
    console.log("Insights:", parsed.insights);

    // 4️⃣ Update Supabase
    console.log("Updating Supabase...");
    const { error: updateError } = await supabase
      .from("entries")
      .update({
        transcript: transcriptText,
        summary: parsed.summary,
        key_insights: parsed.insights,
        status: "completed",
      })
      .eq("id", entry_id);

    if (updateError) {
      console.error("Supabase update error:", updateError);
      throw updateError;
    }

    console.log(`Entry ${entry_id} processed successfully`);

    res.json({ 
      success: true, 
      transcript_length: transcript.length,
      summary_length: parsed.summary.length 
    });

  } catch (err) {
    console.error("Processing error:", err);
    
    // Update entry status to failed
    try {
      await supabase
        .from("entries")
        .update({ status: "failed" })
        .eq("id", req.body.entry_id);
    } catch (dbErr) {
      console.error("Failed to update error status:", dbErr);
    }

    res.status(500).json({ 
      error: "processing_failed", 
      details: err.message 
    });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 ORBIT Worker running on port ${PORT}`);
  console.log(`Environment: ${process.env.SUPABASE_URL ? 'Configured' : 'Missing SUPABASE_URL'}`);
});
