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

  const signature =
    event.headers["stripe-signature"] || event.headers["Stripe-Signature"];

  if (!signature) {
    return {
      statusCode: 400,
      body: "Signature Stripe manquante",
    };
  }

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
        expand: ["customer_details", "line_items"],
      });

      const customerEmail =
        fullSession.customer_details?.email || session.customer_details?.email;

      const customerName =
  fullSession.customer_details?.name ||
  session.metadata?.nom ||
  "Client";

      if (!customerEmail) {
        console.log("Aucun email client trouvé.");
        return {
          statusCode: 200,
          body: "Pas d'email client",
        };
      }

      const service =
        session.metadata?.service || "Diagnostic plomberie en ligne";

      const urgence =
        session.metadata?.urgence || "Non précisée";

      const telephone =
        session.metadata?.telephone || "Non renseigné";

      const probleme =
        session.metadata?.probleme || "Non renseigné";

      const logement =
        session.metadata?.logement || "Non renseigné";

      const ville =
        session.metadata?.ville || "Non renseignée";

      const montant = session.amount_total
        ? `${(session.amount_total / 100).toFixed(2)} €`
        : "Montant non disponible";

      const htmlClient = `
        <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;color:#111;">
          <h2 style="margin-bottom:20px;">Paiement confirmé ✅</h2>

          <p>Bonjour ${customerName},</p>

          <p>
            Nous avons bien reçu votre paiement pour votre
            <strong>${service}</strong>.
          </p>

          <p>
            Votre demande a bien été transmise à <strong>Diag Plomberie France</strong>.
          </p>

          <div style="background:#f6f8fb;padding:18px;border-radius:12px;margin:20px 0;">
            <h3 style="margin-top:0;">Récapitulatif</h3>
            <p><strong>Montant payé :</strong> ${montant}</p>
            <p><strong>Niveau d’urgence :</strong> ${urgence}</p>
            <p><strong>Téléphone :</strong> ${telephone}</p>
            <p><strong>Ville :</strong> ${ville}</p>
            <p><strong>Type de logement :</strong> ${logement}</p>
            <p><strong>Problème déclaré :</strong><br>${probleme}</p>
          </div>

          <p>
            Vous serez recontacté rapidement si nécessaire, ou votre analyse sera traitée selon la formule choisie.
          </p>

          <p>
            Merci pour votre confiance,<br>
            <strong>Diag Plomberie France</strong>
          </p>
        </div>
      `;

      const htmlAdmin = `
        <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;color:#111;">
          <h2>Nouvelle commande payée 💸</h2>

          <p><strong>Client :</strong> ${customerName}</p>
          <p><strong>Email :</strong> ${customerEmail}</p>
          <p><strong>Téléphone :</strong> ${telephone}</p>
          <p><strong>Ville :</strong> ${ville}</p>
          <p><strong>Logement :</strong> ${logement}</p>
          <p><strong>Service :</strong> ${service}</p>
          <p><strong>Urgence :</strong> ${urgence}</p>
          <p><strong>Montant :</strong> ${montant}</p>

          <div style="background:#f6f8fb;padding:18px;border-radius:12px;margin-top:20px;">
            <strong>Problème déclaré :</strong><br><br>
            ${probleme}
          </div>
        </div>
      `;

      const fromEmail = process.env.RESEND_FROM_EMAIL;
      const adminEmail = process.env.ADMIN_EMAIL;

      if (!fromEmail || !adminEmail) {
        console.error("Variables email manquantes.");
        return {
          statusCode: 500,
          body: "Variables email manquantes",
        };
      }

      const clientSend = await resend.emails.send({
        from: fromEmail,
        to: customerEmail,
        subject: "Paiement confirmé - Diag Plomberie France",
        html: htmlClient,
      });

      console.log("Email client :", clientSend);

      const adminSend = await resend.emails.send({
        from: fromEmail,
        to: adminEmail,
        subject: `Nouvelle demande payée - ${customerName}`,
        html: htmlAdmin,
        replyTo: customerEmail,
      });

      console.log("Email admin :", adminSend);
    }

    return {
      statusCode: 200,
      body: "Webhook reçu",
    };
  } catch (err) {
    console.error("Erreur webhook :", err);
    return {
      statusCode: 500,
      body: "Erreur serveur",
    };
  }
};
