const Stripe = require("stripe");
const { Resend } = require("resend");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: "Method Not Allowed",
    };
  }

  const signature = event.headers["stripe-signature"] || event.headers["Stripe-Signature"];

  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Erreur signature Stripe :", err.message);
    return {
      statusCode: 400,
      body: `Webhook Error: ${err.message}`,
    };
  }

  try {
    if (stripeEvent.type === "checkout.session.completed") {
      const session = stripeEvent.data.object;

      const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ["line_items.data.price.product", "customer_details"],
      });

      const customerEmail =
        fullSession.customer_details?.email ||
        session.customer_details?.email ||
        session.customer_email;

      const lineItem = fullSession.line_items?.data?.[0];
      const productName = lineItem?.price?.product?.name || "";

      if (!customerEmail) {
        return {
          statusCode: 200,
          body: JSON.stringify({ received: true, warning: "No customer email" }),
        };
      }

      let subject = "Paiement reçu – envoyez maintenant votre demande plomberie";
      let html = `
        <div style="font-family:Arial,sans-serif;line-height:1.6;color:#222;">
          <h2>Bonjour,</h2>
          <p>Votre paiement a bien été reçu ✅</p>
          <p>Merci pour votre confiance.</p>
          <p>Pour que nous puissions traiter votre demande rapidement, merci d’envoyer maintenant les éléments suivants :</p>
          <ul>
            <li>une description claire du problème</li>
            <li>depuis quand le problème a commencé</li>
            <li>ce que vous avez déjà constaté ou testé</li>
            <li>si possible, des photos ou vidéos</li>
          </ul>
          <p><strong>Rappel de votre niveau de traitement :</strong></p>
          <ul>
            <li>Standard : réponse sous 24h</li>
            <li>Express : réponse en quelques heures</li>
            <li>Urgence : traitement prioritaire</li>
          </ul>
          <p>À très vite,</p>
          <p><strong>Diag Plomberie France</strong><br/>contact@diagplomberiefrance.com</p>
        </div>
      `;

      if (productName === "Urgence WhatsApp immédiate") {
        subject = "Paiement reçu – accès WhatsApp immédiat activé";
        html = `
          <div style="font-family:Arial,sans-serif;line-height:1.6;color:#222;">
            <h2>Bonjour,</h2>
            <p>Votre paiement a bien été validé ✅</p>
            <p>Votre accès prioritaire WhatsApp est maintenant activé.</p>
            <p>Pour un traitement immédiat, envoyez dès maintenant votre message WhatsApp avec :</p>
            <ul>
              <li>le problème rencontré</li>
              <li>depuis quand il a commencé</li>
              <li>une photo ou une vidéo si possible</li>
            </ul>
            <p>
              <strong>Lien WhatsApp direct :</strong><br/>
              <a href="https://wa.me/33678532859?text=Bonjour%20je%20viens%20de%20payer%20une%20urgence">
                Ouvrir WhatsApp maintenant
              </a>
            </p>
            <p>À tout de suite,</p>
            <p><strong>Diag Plomberie France</strong><br/>contact@diagplomberiefrance.com</p>
          </div>
        `;
      }

      await resend.emails.send({
        from: "Diag Plomberie France <contact@diagplomberiefrance.com>",
        to: customerEmail,
        subject,
        html,
      });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ received: true }),
    };
  } catch (error) {
    console.error("Erreur webhook :", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Erreur interne webhook",
        details: error.message,
      }),
    };
  }
};
