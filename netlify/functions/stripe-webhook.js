const Stripe = require("stripe");
const { Resend } = require("resend");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function nl2br(value) {
  return escapeHtml(value).replace(/\n/g, "<br>");
}

function normalizeText(value, fallback = "Non renseigné") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function urgencyColor(urgenceRaw) {
  const u = String(urgenceRaw || "").toLowerCase();

  if (
    u.includes("urgence absolue") ||
    u.includes("très urgent") ||
    u.includes("tres urgent") ||
    u.includes("immédiat") ||
    u.includes("immediat")
  ) {
    return {
      bg: "#ffe5e5",
      border: "#dc2626",
      text: "#991b1b",
      badge: "URGENT",
    };
  }

  if (
    u.includes("urgent") ||
    u.includes("rapide") ||
    u.includes("prioritaire")
  ) {
    return {
      bg: "#fff4e5",
      border: "#f59e0b",
      text: "#92400e",
      badge: "À TRAITER RAPIDEMENT",
    };
  }

  return {
    bg: "#e8f4ff",
    border: "#0d6efd",
    text: "#084298",
    badge: "STANDARD",
  };
}

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

      const type = normalizeText(
        session.metadata?.type,
        "main_diag_plomberie"
      );

      const customerEmail =
        fullSession.customer_details?.email ||
        session.customer_details?.email ||
        session.metadata?.email ||
        session.metadata?.customer_email ||
        "";

      const customerName =
        fullSession.customer_details?.name ||
        session.metadata?.nom ||
        "Client";

      const montant = session.amount_total
        ? `${(session.amount_total / 100).toFixed(2)} €`
        : "Montant non disponible";

      const fromEmail = process.env.RESEND_FROM_EMAIL;
      const adminEmail = process.env.ADMIN_EMAIL;

      const appBaseUrl =
        process.env.URL ||
        process.env.DEPLOY_PRIME_URL ||
        process.env.APP_BASE_URL ||
        "https://diagplomberiefrance.com";

      if (!fromEmail || !adminEmail) {
        console.error("Variables email manquantes.");
        return {
          statusCode: 500,
          body: "Variables email manquantes",
        };
      }

      if (!customerEmail) {
        console.log("Aucun email client trouvé.");
        return {
          statusCode: 200,
          body: "Pas d'email client",
        };
      }

      const service = normalizeText(
        session.metadata?.service,
        "Diagnostic plomberie en ligne"
      );
      const urgence = normalizeText(session.metadata?.urgence, "Non précisée");
      const telephone = normalizeText(
        session.metadata?.telephone,
        "Non renseigné"
      );
      const probleme = normalizeText(
        session.metadata?.probleme,
        "Non renseigné"
      );
      const logement = normalizeText(
        session.metadata?.logement,
        "Non renseigné"
      );
      const ville = normalizeText(session.metadata?.ville, "Non renseignée");

      const safeCustomerName = escapeHtml(customerName);
      const safeCustomerEmail = escapeHtml(customerEmail);
      const safeMontant = escapeHtml(montant);
      const safeSessionId = escapeHtml(session.id);
      const safeType = escapeHtml(type);
      const safeService = escapeHtml(service);
      const safeUrgence = escapeHtml(urgence);
      const safeTelephone = escapeHtml(telephone);
      const safeLogement = escapeHtml(logement);
      const safeVille = escapeHtml(ville);
      const safeProbleme = nl2br(probleme);

      const urgency = urgencyColor(urgence);
      const formUrl = `${appBaseUrl}/upsell.html?session_id=${session.id}`;

      if (type === "upsell_diag_plomberie") {
        const originalSessionId = normalizeText(
          session.metadata?.original_session_id,
          "Non renseignée"
        );

        const htmlAdminUpsell = `
          <div style="margin:0;padding:0;background:#f4f7fb;font-family:Arial,sans-serif;">
            <div style="max-width:760px;margin:0 auto;padding:24px;">
              
              <div style="background:#b91c1c;color:#fff;padding:16px 20px;border-radius:16px 16px 0 0;">
                <div style="font-size:12px;font-weight:800;letter-spacing:1px;text-transform:uppercase;opacity:0.95;">
                  PRIORITAIRE • NOUVEL ACHAT UPSELL
                </div>
                <div style="font-size:28px;font-weight:800;line-height:1.2;margin-top:6px;">
                  🔥 Upsell acheté
                </div>
                <div style="font-size:15px;margin-top:8px;opacity:0.95;">
                  Client : <strong>${safeCustomerName}</strong>
                </div>
              </div>

              <div style="background:#ffffff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 16px 16px;padding:22px;">
                
                <div style="background:#fff3cd;border-left:6px solid #f59e0b;padding:16px 18px;border-radius:12px;margin-bottom:18px;">
                  <div style="font-size:18px;font-weight:800;color:#7c2d12;">
                    OPTION PRIORITAIRE ACHETÉE
                  </div>
                  <div style="margin-top:8px;color:#5b3b00;line-height:1.6;">
                    Traitement prioritaire + conseils complémentaires + réponse enrichie
                  </div>
                </div>

                <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin-bottom:18px;">
                  <div style="font-size:15px;font-weight:800;margin-bottom:12px;color:#111827;">
                    Informations client
                  </div>
                  <p style="margin:8px 0;"><strong>👤 Nom :</strong> ${safeCustomerName}</p>
                  <p style="margin:8px 0;">
                    <strong>✉️ Email :</strong>
                    <a href="mailto:${safeCustomerEmail}" style="color:#0d6efd;text-decoration:none;">${safeCustomerEmail}</a>
                  </p>
                  <p style="margin:8px 0;"><strong>💰 Montant upsell :</strong> ${safeMontant}</p>
                </div>

                <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin-bottom:22px;">
                  <div style="font-size:15px;font-weight:800;margin-bottom:12px;color:#111827;">
                    Références Stripe
                  </div>
                  <p style="margin:8px 0;"><strong>🧾 Session upsell :</strong> ${safeSessionId}</p>
                  <p style="margin:8px 0;"><strong>🔗 Session principale :</strong> ${escapeHtml(originalSessionId)}</p>
                </div>

                <div style="text-align:center;margin-top:28px;">
                  <a href="mailto:${safeCustomerEmail}"
                     style="background:#0d6efd;color:#fff;padding:14px 24px;border-radius:12px;text-decoration:none;font-weight:800;display:inline-block;">
                     👉 Répondre au client
                  </a>
                </div>
              </div>
            </div>
          </div>
        `;

        const adminSend = await resend.emails.send({
          from: fromEmail,
          to: adminEmail,
          subject: `🚨 PRIORITAIRE - UPSELL ACHETÉ - ${customerName} - ${montant}`,
          html: htmlAdminUpsell,
          replyTo: customerEmail,
        });

        console.log("Email admin upsell :", adminSend);

        return {
          statusCode: 200,
          body: "Webhook upsell reçu",
        };
      }

      const htmlClient = `
        <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;color:#111;">
          <h2 style="margin-bottom:20px;">Paiement confirmé ✅</h2>

          <p>Bonjour ${safeCustomerName},</p>

          <p>
            Nous avons bien reçu votre paiement pour votre
            <strong>${safeService}</strong>.
          </p>

          <p>
            Votre paiement est confirmé. Vous pouvez maintenant continuer votre demande
            en cliquant ci-dessous :
          </p>

          <p style="text-align:center;margin:25px 0;">
            <a href="${formUrl}"
               style="background:#0d6efd;color:#fff;padding:14px 22px;border-radius:10px;text-decoration:none;font-weight:700;display:inline-block;">
               👉 Continuer ma demande
            </a>
          </p>

          <p>
            Vous serez redirigé vers l’étape suivante pour finaliser votre parcours.
          </p>

          <div style="background:#f6f8fb;padding:18px;border-radius:12px;margin:20px 0;">
            <h3 style="margin-top:0;">Récapitulatif</h3>
            <p><strong>Montant payé :</strong> ${safeMontant}</p>
            <p><strong>Niveau d’urgence sélectionné :</strong> ${safeUrgence}</p>
            <p><strong>Téléphone saisi avant paiement :</strong> ${safeTelephone}</p>
            <p><strong>Ville :</strong> ${safeVille}</p>
            <p><strong>Type de logement :</strong> ${safeLogement}</p>
            <p><strong>Problème indiqué avant paiement :</strong><br>${safeProbleme}</p>
          </div>

          <p>
            Merci pour votre confiance,<br>
            <strong>Diag Plomberie France</strong>
          </p>
        </div>
      `;

      const htmlAdmin = `
        <div style="margin:0;padding:0;background:#f4f7fb;font-family:Arial,sans-serif;">
          <div style="max-width:760px;margin:0 auto;padding:24px;">

            <div style="background:#b91c1c;color:#fff;padding:16px 20px;border-radius:16px 16px 0 0;">
              <div style="font-size:12px;font-weight:800;letter-spacing:1px;text-transform:uppercase;opacity:0.95;">
                PRIORITAIRE • NOUVELLE DEMANDE PAYÉE
              </div>
              <div style="font-size:30px;font-weight:800;line-height:1.15;margin-top:6px;">
                🚨 Nouvelle demande diagnostic
              </div>
              <div style="font-size:15px;margin-top:8px;opacity:0.95;">
                Action recommandée : traiter rapidement cette demande
              </div>
            </div>

            <div style="background:#ffffff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 16px 16px;padding:22px;">

              <div style="background:${urgency.bg};border-left:7px solid ${urgency.border};padding:18px;border-radius:12px;margin-bottom:18px;">
                <div style="font-size:12px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:${urgency.text};">
                  ${urgency.badge}
                </div>
                <div style="font-size:22px;font-weight:800;color:${urgency.text};margin-top:6px;">
                  ⚠️ Niveau d’urgence : ${safeUrgence}
                </div>
              </div>

              <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin-bottom:18px;">
                <div style="font-size:16px;font-weight:800;margin-bottom:14px;color:#111827;">
                  1. Coordonnées client
                </div>
                <p style="margin:8px 0;"><strong>👤 Nom :</strong> ${safeCustomerName}</p>
                <p style="margin:8px 0;">
                  <strong>✉️ Email :</strong>
                  <a href="mailto:${safeCustomerEmail}" style="color:#0d6efd;text-decoration:none;">${safeCustomerEmail}</a>
                </p>
                <p style="margin:8px 0;">
                  <strong>📞 Téléphone :</strong>
                  <a href="tel:${safeTelephone}" style="color:#0d6efd;text-decoration:none;">${safeTelephone}</a>
                </p>
                <p style="margin:8px 0;"><strong>📍 Ville :</strong> ${safeVille}</p>
                <p style="margin:8px 0;"><strong>🏠 Logement :</strong> ${safeLogement}</p>
              </div>

              <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin-bottom:18px;">
                <div style="font-size:16px;font-weight:800;margin-bottom:14px;color:#111827;">
                  2. Service demandé
                </div>
                <p style="margin:8px 0;"><strong>🧰 Service :</strong> ${safeService}</p>
                <p style="margin:8px 0;"><strong>💰 Montant payé :</strong> ${safeMontant}</p>
                <p style="margin:8px 0;"><strong>🏷️ Type :</strong> ${safeType}</p>
              </div>

              <div style="background:#e8f4ff;border:1px solid #bfdbfe;border-radius:12px;padding:18px;margin-bottom:18px;">
                <div style="font-size:16px;font-weight:800;margin-bottom:14px;color:#0b3b75;">
                  3. Problème déclaré
                </div>
                <div style="font-size:15px;line-height:1.7;color:#111827;white-space:normal;">
                  ${safeProbleme}
                </div>
              </div>

              <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin-bottom:22px;">
                <div style="font-size:16px;font-weight:800;margin-bottom:14px;color:#111827;">
                  4. Référence interne
                </div>
                <p style="margin:8px 0;"><strong>🧾 Session Stripe :</strong> ${safeSessionId}</p>
              </div>

              <div style="text-align:center;margin-top:28px;">
                <a href="mailto:${safeCustomerEmail}"
                   style="background:#0d6efd;color:#fff;padding:14px 24px;border-radius:12px;text-decoration:none;font-weight:800;display:inline-block;">
                   👉 Répondre au client
                </a>
              </div>
            </div>
          </div>
        </div>
      `;

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
        subject: `🚨 PRIORITAIRE - NOUVELLE DEMANDE PAYÉE - ${customerName} - ${urgence} - ${montant}`,
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
