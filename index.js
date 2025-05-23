import express from "express";
import Stripe from "stripe";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2025-04-30.basil",
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

app.get("/", (req, res) => {
  res.send("✅ Stripe webhook is live.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
