// This is your secure "back office" function.
// It is NOT public. The secret keys are safe here.
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

  // Create a new Stripe Customer
  const customer = await stripe.customers.create({
    email: userData.email, // Assumes email is in the user doc
    metadata: {
      firebaseUID: uid,
    },
  });

  // Save the new customer ID to Firestore
  await userRef.set(
    {
      stripeCustomerId: customer.id,
    },
    { merge: true }
  );

  return customer.id;
}

// This is the main function that runs when called
exports.handler = async (event)_ => {
  // 1. Get the data from the front-end
  const { priceId, uid } = JSON.parse(event.body);

  // 2. Check if user is logged in (basic check)
  if (!uid) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "You must be logged in." }),
    };
  }

  try {
    // 3. Get/create the Stripe customer ID
    const stripeCustomerId = await getOrCreateStripeCustomer(uid);

    // 4. Create the Stripe Checkout session
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
      // These URLs are on your LIVE Netlify site
      success_url: `${process.env.URL}/home.html`,
      cancel_url: `${process.env.URL}/manage.html`,
      metadata: {
        firebaseUID: uid, // Pass Firebase UID to the webhook
      },
    });

    // 5. Send the session ID back to the front-end
    return {
      statusCode: 200,
      body: JSON.stringify({ sessionId: session.id }),
    };
  } catch (error) {
    console.error("Error creating Stripe checkout:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
