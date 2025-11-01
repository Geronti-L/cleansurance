const functions = require("firebase-functions");
const admin = require("firebase-admin");
const stripe = require("stripe")(functions.config().stripe.secret);

admin.initializeApp();
const db = admin.firestore();

// --- PLACEHOLDERS ---
// YOU MUST REPLACE THESE WITH YOUR LIVE NETLIFY DOMAIN
const YOUR_NETLIFY_SUCCESS_URL = "https://https://cleansurance.net//home.html";
const YOUR_NETLIFY_CANCEL_URL = "https://https://cleansurance.net//manage.html";
const YOUR_NETLIFY_PORTAL_RETURN_URL = "https://https://cleansurance.net//home.html";

// YOU MUST REPLACE THESE WITH YOUR PRICE IDS FROM YOUR STRIPE DASHBOARD
const PRICE_ID_BASIC = "price_...prod_TLB65SIshD02dK...";
const PRICE_ID_PLUS = "price_...prod_TLB6MKNU99DHZQ...";
const PRICE_ID_PREMIUM = "price_...prod_TLB6gIz6nSXhFm...";
// ------------------------------------


/**
 * Gets or creates a Stripe Customer ID for a Firebase user.
 * This is robust and handles all your users automatically.
 */
async function getOrCreateStripeCustomer(uid) {
  const userDoc = await db.collection("users").doc(uid).get();
  const userData = userDoc.data();
  
  if (userData && userData.stripeCustomerId) {
    return userData.stripeCustomerId;
  }

  // Create a new Stripe Customer
  const customer = await stripe.customers.create({
    email: userData.email, // Assumes email is in the user doc
    metadata: {
      firebaseUID: uid,
    },
  });

  // Save the new customer ID to Firestore
  await db.collection("users").doc(uid).set(
    {
      stripeCustomerId: customer.id,
    },
    { merge: true } // Merge, so it doesn't overwrite other user data
  );

  return customer.id;
}

/**
 * [Callable Function]
 * Creates a Stripe Checkout session for a user to subscribe.
 * This is called by your 'manage.html' page.
 */
exports.createStripeCheckout = functions.https.onCall(
  async (data, context) => {
    // Check if user is authenticated
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "You must be logged in to purchase a plan."
      );
    }

    const uid = context.auth.uid;
    const priceId = data.priceId;

    try {
      const stripeCustomerId = await getOrCreateStripeCustomer(uid);

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "subscription",
        customer: stripeCustomerId,
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        // Set success/cancel URLs to your *Netlify* site
        success_url: `${YOUR_NETLIFY_DOMAIN}/home.html`,
        cancel_url: `${YOUR_NETLIFY_DOMAIN}/manage.html`,
        metadata: {
          firebaseUID: uid, // Pass Firebase UID to the webhook
        },
      });

      return {
        sessionId: session.id,
      };
    } catch (error) {
      console.error("Error creating Stripe checkout:", error.message);
      throw new functions.https.HttpsError("internal", error.message);
    }
  }
);

/**
 * [Callable Function]
 * Creates a Stripe Billing Portal session for the user to manage their subscription.
 * This is called by your 'manage.html' page.
 */
exports.createStripePortal = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "You must be logged in."
    );
  }

  try {
    const uid = context.auth.uid;
    const stripeCustomerId = await getOrCreateStripeCustomer(uid);

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${YOUR_NETLIFY_DOMAIN}/home.html`, // Your Netlify site
    });

    return {
      url: portalSession.url,
    };
  } catch (error) {
    console.error("Error creating Stripe portal:", error.message);
    throw new functions.https.HttpsError("internal", error.message);
  }
});

/**
 * [Webhook Function]
 * Listens for events from Stripe to update your Firestore database.
 * This is the *most critical* part.
 */
exports.stripeWebhook = functions.https.onRequest(async (req, res) => {
  const sig = req.headers["stripe-signature"];
  // Get your webhook secret from the Stripe dashboard
  // Set it by running in your terminal:
  // firebase functions:config:set stripe.webhooksecret="whsec_..."
  const endpointSecret = functions.config().stripe.webhooksecret;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, endpointSecret);
  } catch (err) {
    console.error("Webhook signature verification failed.", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const data = event.data.object;

  try {
    // Handle successful checkout
    if (event.type === "checkout.session.completed") {
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
          startDate: admin.firestore.Timestamp.fromMillis(
            subscription.current_period_start * 1000
          ),
          endDate: admin.firestore.Timestamp.fromMillis(
            subscription.current_period_end * 1000
          ),
        },
      });
    }

    // Handle subscription updates (cancellations, renewals)
    if (
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const subscription = data;
      const query = db
        .collection("users")
        .where("plan.stripeSubscriptionId", "==", subscription.id);
        
      const userSnapshot = await query.get();

      if (!userSnapshot.empty) {
        const uid = userSnapshot.docs[0].id;
        const newStatus = subscription.status; // e.g., 'active', 'canceled', 'past_due'
        
        let planUpdate = {
          "plan.status": newStatus,
          "plan.endDate": admin.firestore.Timestamp.fromMillis(
            subscription.current_period_end * 1000
          ),
        };

        // If canceled, mark it but keep data until period end
        if (subscription.canceled_at) {
          planUpdate["plan.status"] = "canceled";
          planUpdate["plan.canceled_at"] = admin.firestore.Timestamp.fromMillis(
            subscription.canceled_at * 1000
          );
        }

        await db.collection("users").doc(uid).update(planUpdate);
      }
    }
  } catch (error) {
    console.error("Error in webhook handler:", error.message);
    return res.status(500).send("Internal server error");
  }

  // Acknowledge receipt of the event
  res.status(200).send();
});


// --- Helper Functions ---
// These helpers map your Stripe Price IDs to human-readable names and prices
// This ensures your database stores clean, readable data.

function getPlanName(planId) {
  switch (planId) {
    case PRICE_ID_BASIC:
      return "Cleansurance Basic";
    case PRICE_ID_PLUS:
      return "Cleansurance Plus";
    case PRICE_ID_PREMIUM:
      return "Cleansurance Premium";
    default:
      return "Unknown Plan";
  }
}

function getPlanPrice(planId) {
  switch (planId) {
    case PRICE_ID_BASIC:
      return 5;
    case PRICE_ID_PLUS:
      return 8;
    case PRICE_ID_PREMIUM:
      return 12;
    default:
      return 0;
  }
}
