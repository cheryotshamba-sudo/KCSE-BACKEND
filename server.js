const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 10000;

// ======================================================
// CONFIGURATION
// ======================================================

const PAYLOR_API_KEY = process.env.PAYLOR_API_KEY;
const PAYLOR_CHANNEL_ID = process.env.PAYLOR_CHANNEL_ID;
const PAYLOR_WEBHOOK_SECRET = process.env.PAYLOR_WEBHOOK_SECRET;

const BACKEND_URL = process.env.BACKEND_URL;

const PAYLOR_BASE_URL =
"https://api.paylorke.com/api/v1";

// ======================================================
// MIDDLEWARE
// ======================================================

app.use(cors());

/*
Keep the raw request body because Paylor webhook
signatures are calculated from the exact body.
*/
app.use(
express.json({
verify: (req, res, buf) => {
req.rawBody = buf;
}
})
);

// ======================================================
// TEMPORARY TRANSACTION STORAGE
// ======================================================

const transactions = new Map();

// ======================================================
// HEALTH CHECK
// ======================================================

app.get("/", (req, res) => {
res.json({
online: true,
service: "KCSE Revision Papers Payment Backend",
paylorApiKeyConfigured: !!PAYLOR_API_KEY,
paylorChannelConfigured: !!PAYLOR_CHANNEL_ID,
webhookSecretConfigured: !!PAYLOR_WEBHOOK_SECRET
});
});

// ======================================================
// START PAYMENT
// ======================================================

app.post("/api/payment", async (req, res) => {

try {

const {
  phone,
  amount,
  paper,
  paperCode
} = req.body;

// --------------------------------------------------
// VALIDATION
// --------------------------------------------------

if (!phone) {
  return res.status(400).json({
    success: false,
    message: "Phone number is required."
  });
}

if (!paper) {
  return res.status(400).json({
    success: false,
    message: "Paper is required."
  });
}

if (!PAYLOR_API_KEY) {
  return res.status(500).json({
    success: false,
    message: "Paylor API key is not configured."
  });
}

// We only allow KSh 100 for the revision paper.
const paymentAmount = 100;

if (Number(amount) !== paymentAmount) {
  return res.status(400).json({
    success: false,
    message: "Invalid payment amount."
  });
}

// --------------------------------------------------
// CONVERT PHONE TO 254 FORMAT
// --------------------------------------------------

let formattedPhone = String(phone).replace(/\s+/g, "");

if (formattedPhone.startsWith("0")) {
  formattedPhone = "254" + formattedPhone.substring(1);
}

if (!/^254(7|1)\d{8}$/.test(formattedPhone)) {
  return res.status(400).json({
    success: false,
    message: "Invalid Kenyan M-Pesa phone number."
  });
}

// --------------------------------------------------
// CREATE UNIQUE REFERENCE
// --------------------------------------------------

const reference =
  "PAPER-" +
  Date.now() +
  "-" +
  crypto.randomBytes(3).toString("hex").toUpperCase();

// --------------------------------------------------
// SAVE TRANSACTION LOCALLY
// --------------------------------------------------

transactions.set(reference, {
  reference,
  phone: formattedPhone,
  amount: paymentAmount,
  paper,
  paperCode,
  status: "PENDING",
  createdAt: new Date().toISOString()
});

// --------------------------------------------------
// PAYLOR REQUEST
// --------------------------------------------------

const callbackUrl =
  BACKEND_URL
    ? `${BACKEND_URL}/api/paylor-callback`
    : undefined;

const payload = {
  phone: formattedPhone,
  amount: paymentAmount,
  reference: reference,
  description: `Revision paper - ${paper}`
};

// Use the selected Paylor channel if configured.
if (PAYLOR_CHANNEL_ID) {
  payload.channelId = PAYLOR_CHANNEL_ID;
}

// Tell Paylor where to send the payment result.
if (callbackUrl) {
  payload.callbackUrl = callbackUrl;
}

console.log("Sending STK Push:", {
  phone: formattedPhone,
  amount: paymentAmount,
  reference,
  paper,
  paperCode
});

const response = await fetch(
  `${PAYLOR_BASE_URL}/merchants/payments/stk-push`,
  {
    method: "POST",

    headers: {
      "Authorization": `Bearer ${PAYLOR_API_KEY}`,
      "Content-Type": "application/json"
    },

    body: JSON.stringify(payload)
  }
);

const data = await response.json();

console.log("Paylor response:", data);

if (!response.ok) {

  transactions.set(reference, {
    ...transactions.get(reference),
    status: "FAILED",
    paylorResponse: data
  });

  return res.status(response.status).json({
    success: false,
    message:
      data.message ||
      data.error ||
      "Paylor payment request failed.",
    reference
  });
}

// --------------------------------------------------
// SAVE PAYLOR TRANSACTION ID
// --------------------------------------------------

const transactionId =
  data.transactionId ||
  data.id ||
  null;

transactions.set(reference, {
  ...transactions.get(reference),
  transactionId,
  status: data.status || "SENT",
  paylorResponse: data
});

// --------------------------------------------------
// RESPONSE TO FRONTEND
// --------------------------------------------------

return res.json({
  success: true,
  reference,
  transactionId,
  status: data.status || "SENT",
  message:
    "STK Push sent successfully. Check your phone and enter your M-Pesa PIN."
});

} catch (error) {

console.error("Payment error:", error);

return res.status(500).json({
  success: false,
  message: "Unable to start payment.",
  error: error.message
});

}
});

// ======================================================
// PAYLOR CALLBACK / WEBHOOK
// ======================================================

app.post("/api/paylor-callback", (req, res) => {

try {

const signature =
  req.headers["x-webhook-signature"];

// --------------------------------------------------
// VERIFY PAYLOR SIGNATURE
// --------------------------------------------------

if (PAYLOR_WEBHOOK_SECRET) {

  if (!signature) {
    console.log("Webhook rejected: missing signature.");

    return res.status(401).json({
      success: false,
      message: "Missing webhook signature."
    });
  }

  const expectedSignature =
    crypto
      .createHmac(
        "sha256",
        PAYLOR_WEBHOOK_SECRET
      )
      .update(req.rawBody)
      .digest("hex");

  if (
    signature.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    )
  ) {

    console.log("Webhook rejected: invalid signature.");

    return res.status(401).json({
      success: false,
      message: "Invalid webhook signature."
    });
  }
}

// --------------------------------------------------
// READ CALLBACK
// --------------------------------------------------

const payload = req.body;

console.log(
  "Paylor webhook received:",
  JSON.stringify(payload, null, 2)
);

const event = payload.event;

const transaction =
  payload.transaction || payload;

const reference =
  transaction.reference ||
  payload.reference;

if (!reference) {
  return res.status(200).json({
    received: true
  });
}

const existing =
  transactions.get(reference);

// --------------------------------------------------
// PAYMENT SUCCESS
// --------------------------------------------------

if (
  event === "payment.success" ||
  transaction.status === "COMPLETED"
) {

  transactions.set(reference, {
    ...(existing || {}),
    reference,
    status: "COMPLETED",
    paylorData: payload,
    completedAt: new Date().toISOString()
  });

  console.log(
    "PAYMENT COMPLETED:",
    reference
  );
}

// --------------------------------------------------
// PAYMENT FAILED
// --------------------------------------------------

else if (
  event === "payment.failed" ||
  transaction.status === "FAILED"
) {

  transactions.set(reference, {
    ...(existing || {}),
    reference,
    status: "FAILED",
    paylorData: payload,
    failedAt: new Date().toISOString()
  });

  console.log(
    "PAYMENT FAILED:",
    reference
  );
}

return res.status(200).json({
  received: true
});

} catch (error) {

console.error(
  "Webhook error:",
  error
);

return res.status(500).json({
  received: false
});

}
});

// ======================================================
// CHECK PAYMENT STATUS
// ======================================================

app.get("/api/payment-status/:reference", async (req, res) => {

try {

const reference =
  req.params.reference;

const localTransaction =
  transactions.get(reference);

if (!localTransaction) {

  return res.status(404).json({
    success: false,
    message: "Transaction not found."
  });
}

// --------------------------------------------------
// IF ALREADY COMPLETED
// --------------------------------------------------

if (
  localTransaction.status === "COMPLETED"
) {

  return res.json({
    success: true,
    status: "COMPLETED",
    reference,
    paper: localTransaction.paper,
    paperCode: localTransaction.paperCode
  });
}

// --------------------------------------------------
// QUERY PAYLOR IF TRANSACTION ID EXISTS
// --------------------------------------------------

if (localTransaction.transactionId) {

  const response = await fetch(
    `${PAYLOR_BASE_URL}/merchants/payments/transactions/${localTransaction.transactionId}`,
    {
      method: "GET",

      headers: {
        "Authorization": `Bearer ${PAYLOR_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );

  const data = await response.json();

  console.log(
    "Paylor status response:",
    data
  );

  if (response.ok) {

    const paylorStatus =
      String(data.status || "").toUpperCase();

    if (
      paylorStatus === "COMPLETED" ||
      paylorStatus === "SUCCESS"
    ) {

      transactions.set(reference, {
        ...localTransaction,
        status: "COMPLETED",
        paylorData: data
      });

      return res.json({
        success: true,
        status: "COMPLETED",
        reference,
        paper: localTransaction.paper,
        paperCode: localTransaction.paperCode
      });
    }

    if (
      paylorStatus === "FAILED" ||
      paylorStatus === "CANCELLED"
    ) {

      transactions.set(reference, {
        ...localTransaction,
        status: "FAILED",
        paylorData: data
      });

      return res.json({
        success: true,
        status: "FAILED",
        reference
      });
    }

    return res.json({
      success: true,
      status: "PENDING",
      reference
    });
  }
}

// --------------------------------------------------
// STILL WAITING
// --------------------------------------------------

return res.json({
  success: true,
  status: "PENDING",
  reference
});

} catch (error) {

console.error(
  "Status check error:",
  error
);

return res.status(500).json({
  success: false,
  message: "Unable to check payment status."
});

}
});

// ======================================================
// START SERVER
// ======================================================

app.listen(PORT, () => {

console.log(
"KCSE Revision Papers backend running on port ${PORT}"
);

console.log(
"Paylor API configured:",
!!PAYLOR_API_KEY
);

console.log(
"Paylor channel configured:",
!!PAYLOR_CHANNEL_ID
);

console.log(
"Paylor webhook configured:",
!!PAYLOR_WEBHOOK_SECRET
);
});
