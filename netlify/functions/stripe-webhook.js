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

      const formUrl = `${process.env.APP_BASE_URL}/merci.html?session_id=${session.id}`;

      const htmlClient = `
        <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;color:#111;">
          <h2 style="margin-bottom:20px;">Paiement confirmé ✅</h2>

          <p>Bonjour ${customerName},</p>

          <p>
            Nous avons bien reçu votre paiement pour votre
            <strong>${service}</strong>.
          </p>

          <p>
            Votre paiement est confirmé. Vous pouvez maintenant envoyer votre demande complète
            (photos, vidéos, détails) en cliquant ci-dessous :
          </p>

          <p style="text-align:center;margin:25px 0;">
            <a href="${formUrl}"
               style="background:#0d6efd;color:#fff;padding:14px 22px;border-radius:10px;text-decoration:none;font-weight:700;display:inline-block;">
               👉 Accéder à mon formulaire
            </a>
          </p>

          <p>
            Ce formulaire vous permet de transmettre tous les éléments nécessaires pour votre diagnostic.
          </p>

          <div style="background:#f6f8fb;padding:18px;border-radius:12px;margin:20px 0;">
            <h3 style="margin-top:0;">Récapitulatif</h3>
            <p><strong>Montant payé :</strong> ${montant}</p>
            <p><strong>Niveau d’urgence sélectionné :</strong> ${urgence}</p>
            <p><strong>Téléphone saisi avant paiement :</strong> ${telephone}</p>
            <p><strong>Ville :</strong> ${ville}</p>
            <p><strong>Type de logement :</strong> ${logement}</p>
            <p><strong>Problème indiqué avant paiement :</strong><br>${probleme}</p>
          </div>

          <p>
            Plus votre demande finale sera précise, plus votre diagnostic pourra être rapide et fiable.
          </p>

          <p>
            Merci pour votre confiance,<br>
            <strong>Diag Plomberie France</strong>
          </p>
        </div>
      `;

      const htmlAdmin = `
        <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;color:#111;">
          <h2 style="margin-bottom:10px;">🚨 Nouvelle demande diagnostic</h2>

          <div style="background:#f6f8fb;padding:16px;border-radius:12px;margin-bottom:20px;">
            <p style="margin:5px 0;"><strong>👤 Client :</strong> ${customerName}</p>
            <p style="margin:5px 0;">
              <strong>✉️ Email :</strong>
              <a href="mailto:${customerEmail}" style="color:#0d6efd;text-decoration:none;">${customerEmail}</a>
            </p>
            <p style="margin:5px 0;">
              <strong>📞 Téléphone :</strong>
              <a href="tel:${telephone}" style="color:#0d6efd;text-decoration:none;">${telephone}</a>
            </p>
            <p style="margin:5px 0;"><strong>📍 Ville :</strong> ${ville}</p>
            <p style="margin:5px 0;"><strong>🏠 Logement :</strong> ${logement}</p>
            <p style="margin:5px 0;"><strong>🧰 Service :</strong> ${service}</p>
          </div>

          <div style="background:#fff3cd;padding:16px;border-radius:12px;margin-bottom:20px;">
            <strong>⚠️ URGENCE :</strong> ${urgence}
          </div>

          <div style="background:#e8f4ff;padding:18px;border-radius:12px;margin-bottom:20px;">
            <strong>🛠️ PROBLÈME :</strong>
            <div style="margin-top:10px;line-height:1.6;white-space:pre-line;">
              ${probleme}
            </div>
          </div>

          <div style="background:#f6f8fb;padding:16px;border-radius:12px;margin-bottom:20px;">
            <p style="margin:5px 0;"><strong>💰 Montant :</strong> ${montant}</p>
            <p style="margin:5px 0;"><strong>🧾 Session Stripe :</strong> ${session.id}</p>
          </div>

          <div style="text-align:center;margin-top:30px;">
            <a href="mailto:${customerEmail}"
               style="background:#0d6efd;color:#fff;padding:14px 22px;border-radius:10px;text-decoration:none;font-weight:700;display:inline-block;">
               👉 Répondre au client
            </a>
          </div>
        </div>
      `;

      const fromEmail = process.env.RESEND_FROM_EMAIL;
      const adminEmail = process.env.ADMIN_EMAIL;
      const appBaseUrl = process.env.APP_BASE_URL;

      if (!fromEmail || !adminEmail || !appBaseUrl) {
        console.error("Variables email ou APP_BASE_URL manquantes.");
        return {
          statusCode: 500,
          body: "Variables email ou APP_BASE_URL manquantes",
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
