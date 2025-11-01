// This is the private "back office door" for Stripe to call.
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");

// Get our secrets from Netlify environment variables
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const projectId = process.env.FIREBASE_PROJECT_ID;

// Connect to our Firebase database
let db;
try {
  const app = initializeApp({
    credential: cert(serviceAccount),
    projectId: projectId,
  });
  db = getFirestore(app);
} catch (e) {
  console.error("Failed to initialize Firebase Admin:", e.message);
}

// --- Helper Functions to get plan details from Price IDs ---
// You MUST fill these in with your real Price IDs from Stripe
const PRICE_ID_BASIC = "price_...prod_TLB65SIshD02dK...";
const PRICE_ID_PLUS = "price_...prod_TLB6MKNU99DHZQ...";
const PRICE_ID_PREMIUM = "price_...prod_TLB6gIz6nSXhFm...";

function getPlanName(planId) {
  switch (planId) {
    case PRICE_ID_BASIC: return "Cleansurance Basic";
    case PRICE_ID_PLUS: return "Cleansurance Plus";
    case PRICE_ID_PREMIUM: return "Cleansurance Premium";
    default: return "Unknown Plan";
  }
}
function getPlanPrice(planId) {
  switch (planId) {
    case PRICE_ID_BASIC: return 5;
    case PRICE_ID_PLUS: return 8;
    case PRICE_ID_PREMIUM: return 12;
    default: return 0;
  }
}
// --------------------------------------------------------

exports.handler = async (event) => {
  const sig = event.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, endpointSecret);
  } catch (err) {
    console.warn("Webhook signature verification failed.", err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  const data = stripeEvent.data.object;

  try {
    // Handle successful checkout
    if (stripeEvent.type === "checkout.session.completed") {
      const session = data;
      const uid = session.metadata.firebaseUID;
      const subscription = await stripe.subscriptions.retrieve(
        session.subscription
      );

      const planId = subscription.items.data[0].price.id;

      // Save plan to user's doc
      await db.collection("users").doc(uid).update({
        plan: {
          name: getPlanName(planId),
          price: getPlanPrice(planId),
          planId: planId,
          status: subscription.status,
          stripeSubscriptionId: session.subscription,
          startDate: Timestamp.fromMillis(
            subscription.current_period_start * 1000
          ),
          endDate: Timestamp.fromMillis(
            subscription.current_period_end * 1000
          ),
        },
      });
    }

    // Handle subscription updates (cancellations, renewals)
    if (
      stripeEvent.type === "customer.subscription.updated" ||
      stripeEvent.type === "customer.subscription.deleted"
    ) {
      const subscription = data;
      const query = db
        .collection("users")
        .where("plan.stripeSubscriptionId", "==", subscription.id);
        
      const userSnapshot = await query.get();

      if (!userSnapshot.empty) {
        const uid = userSnapshot.docs[0].id;
        const newStatus = subscription.status;
        
        let planUpdate = {
          "plan.status": newStatus,
          "plan.endDate": Timestamp.fromMillis(
            subscription.current_period_end * 1000
          ),
        };

        if (subscription.canceled_at) {
          planUpdate["plan.status"] = "canceled";
          planUpdate["plan.canceled_at"] = Timestamp.fromMillis(
            subscription.canceled_at * 1000
          );
        }
        await db.collection("users").doc(uid).update(planUpdate);
      }
    }
  } catch (error) {
    console.error("Error in webhook handler:", error.message);
    return { statusCode: 500, body: "Internal server error" };
  }

  // Acknowledge receipt of the event
  return { statusCode: 200 };
};
