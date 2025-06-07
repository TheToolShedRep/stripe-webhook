const express = require("express");
const Stripe = require("stripe");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

dotenv.config();

console.log("📦 SUPABASE_URL from .env:", process.env.SUPABASE_URL);



// testing pathes
ffmpeg.setFfmpegPath(ffmpegPath);
// const path = require("path");
// import path from "path";



const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2025-04-30.basil",
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 🔽 ADD THESE HERE
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const upload = multer({ dest: "uploads/" });

app.use(cors());
app.use(
  "/webhook",
  bodyParser.raw({ type: "application/json" })
);

app.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error("❌ Stripe signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const customerId = session.customer ?? null;
    const subscriptionId = session.subscription ?? null;
    let customerEmail = session.customer_email ?? null;

    if (!customerEmail && customerId) {
      const customer = await stripe.customers.retrieve(customerId);
      if (!customer.deleted) {
        customerEmail = customer.email ?? null;
      }
    }

    if (!customerEmail) {
      console.warn("⚠️ No customer email found — skipping.");
      return res.status(400).send("Missing email.");
    }

    const { error } = await supabase.from("pro_users").upsert(
      {
        user_email: customerEmail,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        pro_since: new Date().toISOString(),
        is_active: true,
      },
      { onConflict: "user_email" }
    );

    if (error) {
      console.error("❌ Supabase insert error:", error.message);
      return res.status(500).send("Database error");
    }

    console.log("✅ Pro user saved:", customerEmail);
  }

  res.status(200).send("Received");
});

app.post("/convert", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) {
      console.error("❌ No file uploaded.");
      return res.status(400).json({ error: "No file uploaded." });
    }

    console.log("✅ File received:", req.file);

    const filePath = req.file.path;
    const baseName = path.basename(filePath);
    const gifPath = `outputs/${baseName}.gif`;
    const audioPath = `outputs/${baseName}.mp3`;

    // Convert to GIF
    console.log("🔁 Starting GIF conversion...");
    await new Promise((resolve, reject) => {
      ffmpeg(filePath)
        .setStartTime(0)
        .duration(5)
        .outputOptions("-vf", "fps=10")
        .output(gifPath)
        .on("end", () => {
          console.log("✅ GIF created");
          resolve();
        })
        .on("error", (err) => {
          console.error("❌ GIF conversion failed:", err.message);
          reject(err);
        })
        .run();
    });

    // Extract audio
    console.log("🔁 Starting audio extraction...");
    await new Promise((resolve, reject) => {
      ffmpeg(filePath)
        .noVideo()
        .audioCodec("libmp3lame")
        .save(audioPath)
        .on("end", () => {
          console.log("✅ Audio extracted");
          resolve();
        })
        .on("error", (err) => {
          console.error("❌ Audio extraction failed:", err.message);
          reject(err);
        });
    });

    // Transcribe
    console.log("🧠 Sending to Whisper...");
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: "whisper-1",
    });

    console.log("✅ Transcription received");

    const gifBuffer = fs.readFileSync(gifPath);

    return res.status(200).json({
      transcript: transcription.text,
      gifBase64: gifBuffer.toString("base64"),
    });
  } catch (err) {
    console.error("❌ Final catch error:", err.message);
    return res.status(500).json({ error: "Failed to process video" });
  }
});




app.get("/", (req, res) => {
  res.send("✅ Stripe webhook is live.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
