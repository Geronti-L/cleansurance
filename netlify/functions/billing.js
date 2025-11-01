const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

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

/**
 * Gets or creates a Stripe Customer ID for a Firebase user.
 */
async function getOrCreateStripeCustomer(uid) {
  if (!db) {
    throw new Error("Database not initialized.");
  }
  
  const userRef = db.collection("users").doc(uid);
  const userDoc = await userRef.get();
  const userData = userDoc.data();

  if (userData && userData.stripeCustomerId) {
    return userData.stripeCustomerId;
  }

  const customer = await stripe.customers.create({
    email: userData.email,
    metadata: { firebaseUID: uid },
  });
  await userRef.set({ stripeCustomerId: customer.id }, { merge: true });
  return customer.id;
}

// This is the main function
exports.handler = async (event) => {
  const { uid } = JSON.parse(event.body);

  if (!uid) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "You must be logged in." }),
    };
  }

  try {
    const stripeCustomerId = await getOrCreateStripeCustomer(uid);

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${process.env.URL}/home.html`, // Your Netlify site
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ url: portalSession.url }),
    };
  } catch (error) {
    console.error("Error creating Stripe portal:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
