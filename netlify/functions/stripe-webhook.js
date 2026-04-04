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
  return String(value).trim();
}

function parseAdminEmails(value) {
  return String(value || "")
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
}

function getPrioriteLabel(upsell, urgence) {
  if (upsell === "oui") return "PRIORITAIRE";

  const u = String(urgence || "").toLowerCase();

  if (
    u.includes("urgence absolue") ||
    u.includes("très urgent") ||
    u.includes("tres urgent") ||
    u.includes("immédiat") ||
    u.includes("immediat")
  ) {
    return "URGENT";
  }

  if (
    u.includes("urgent") ||
    u.includes("rapide") ||
    u.includes("prioritaire")
  ) {
    return "À TRAITER RAPIDEMENT";
  }

  return "STANDARD";
}

function getPrioriteStyle(priorite) {
  if (priorite === "PRIORITAIRE") {
    return {
      bg: "#ffe5e5",
      border: "#dc2626",
      text: "#991b1b"
    };
  }

  if (priorite === "URGENT") {
    return {
      bg: "#fff4e5",
      border: "#f59e0b",
      text: "#92400e"
    };
  }

  if (priorite === "À TRAITER RAPIDEMENT") {
    return {
      bg: "#fff7ed",
      border: "#fb923c",
      text: "#9a3412"
    };
  }

  return {
    bg: "#e8f4ff",
    border: "#0d6efd",
    text: "#084298"
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: "Method Not Allowed"
    };
  }

  const signature =
    event.headers["stripe-signature"] || event.headers["Stripe-Signature"];

  if (!signature) {
    return {
      statusCode: 400,
      body: "Signature Stripe manquante"
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
      body: `Webhook Error: ${err.message}`
    };
  }

  try {
    if (stripeEvent.type === "checkout.session.completed") {
      const session = stripeEvent.data.object;

      const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ["customer_details", "line_items"]
      });

      const fromEmail = process.env.RESEND_FROM_EMAIL;
      const adminEmail = process.env.ADMIN_EMAIL;
      const adminRecipients = parseAdminEmails(adminEmail);

      const appBaseUrl =
        process.env.URL ||
        process.env.DEPLOY_PRIME_URL ||
        process.env.APP_BASE_URL ||
        "https://diagplomberiefrance.com";

      if (!fromEmail || adminRecipients.length === 0) {
        console.error("Variables email manquantes.", {
          hasFromEmail: Boolean(fromEmail),
          adminRecipientsCount: adminRecipients.length
        });

        return {
          statusCode: 500,
          body: "Variables email manquantes"
        };
      }

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

      if (!customerEmail) {
        console.log("Aucun email client trouvé.");
        return {
          statusCode: 200,
          body: "Pas d'email client"
        };
      }

      const nom =
        fullSession.customer_details?.name ||
        session.metadata?.nom ||
        "Client";

      const email = customerEmail;
      const telephone = normalizeText(
        session.metadata?.telephone,
        "Non renseigné"
      );
      const ville = normalizeText(session.metadata?.ville, "Non renseignée");
      const logement = normalizeText(
        session.metadata?.logement,
        "Non renseigné"
      );
      const service = normalizeText(
        session.metadata?.service,
        "Diagnostic plomberie en ligne"
      );
      const urgence = normalizeText(session.metadata?.urgence, "Non précisée");
      const probleme = normalizeText(
        session.metadata?.probleme,
        "Non renseigné"
      );

      const montant = session.amount_total
        ? `${(session.amount_total / 100).toFixed(2)} €`
        : "Montant non disponible";

      const upsell = type === "upsell_diag_plomberie" ? "oui" : "non";
      const priorite = getPrioriteLabel(upsell, urgence);
      const prioriteStyle = getPrioriteStyle(priorite);

      const safeNom = escapeHtml(nom);
      const safeEmail = escapeHtml(email);
      const safeTelephone = escapeHtml(telephone);
      const safeVille = escapeHtml(ville);
      const safeLogement = escapeHtml(logement);
      const safeService = escapeHtml(service);
      const safeUrgence = escapeHtml(urgence);
      const safeProbleme = nl2br(probleme);
      const safeMontant = escapeHtml(montant);
      const safeSessionId = escapeHtml(session.id);
      const safePriorite = escapeHtml(priorite);
      const safeType = escapeHtml(type);

      if (type === "upsell_diag_plomberie") {
        const originalSessionId = normalizeText(
          session.metadata?.original_session_id,
          "Non renseignée"
        );

        const htmlAdminUpsell = `
          <div style="margin:0;padding:0;background:#f4f7fb;font-family:Arial,sans-serif;">
            <div style="max-width:760px;margin:0 auto;padding:24px;">
              <div style="background:#b91c1c;color:#fff;padding:16px 20px;border-radius:16px 16px 0 0;">
                <div style="font-size:12px;font-weight:800;letter-spacing:1px;text-transform:uppercase;">
                  PAIEMENT UPSSELL REÇU
                </div>
                <div style="font-size:28px;font-weight:800;line-height:1.2;margin-top:6px;">
                  🔥 Option prioritaire achetée
                </div>
              </div>

              <div style="background:#ffffff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 16px 16px;padding:22px;">
                <div style="background:#ffe5e5;border-left:7px solid #dc2626;padding:18px;border-radius:12px;margin-bottom:18px;">
                  <div style="font-size:12px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#991b1b;">
                    PRIORITÉ
                  </div>
                  <div style="font-size:22px;font-weight:800;color:#991b1b;margin-top:6px;">
                    ${safePriorite}
                  </div>
                </div>

                <div style="background:#111827;color:#fff;padding:14px;border-radius:10px;margin-bottom:18px;text-align:center;font-weight:800;">
                  Paiement upsell confirmé
                </div>

                <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin-bottom:18px;">
                  <div style="font-size:16px;font-weight:800;margin-bottom:14px;color:#111827;">
                    Coordonnées client
                  </div>
                  <p style="margin:8px 0;"><strong>Nom :</strong> ${safeNom}</p>
                  <p style="margin:8px 0;"><strong>Email :</strong> <a href="mailto:${email}" style="color:#0d6efd;text-decoration:none;">${safeEmail}</a></p>
                </div>

                <div style="background:#fff3cd;border:1px solid #fcd34d;border-radius:12px;padding:18px;margin-bottom:18px;">
                  <div style="font-size:16px;font-weight:800;margin-bottom:14px;color:#7c2d12;">
                    Détail de l'upsell
                  </div>
                  <p style="margin:8px 0;"><strong>Montant :</strong> ${safeMontant}</p>
                  <p style="margin:8px 0;"><strong>Option :</strong> Traitement prioritaire + conseils complémentaires + réponse enrichie</p>
                </div>

                <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin-bottom:22px;">
                  <div style="font-size:16px;font-weight:800;margin-bottom:14px;color:#111827;">
                    Références Stripe
                  </div>
                  <p style="margin:8px 0;"><strong>Session upsell :</strong> ${safeSessionId}</p>
                  <p style="margin:8px 0;"><strong>Session principale :</strong> ${escapeHtml(originalSessionId)}</p>
                </div>

                <div style="text-align:center;margin-top:28px;">
                  <a href="mailto:${email}"
                     style="background:#0d6efd;color:#fff;padding:14px 24px;border-radius:12px;text-decoration:none;font-weight:800;display:inline-block;">
                     👉 Répondre au client
                  </a>
                </div>
              </div>
            </div>
          </div>
        `;

        await resend.emails.send({
          from: fromEmail,
          to: adminRecipients,
          subject: `💳 UPSELL PAYÉ - ${nom} - ${montant}`,
          html: htmlAdminUpsell,
          replyTo: customerEmail
        });

        return {
          statusCode: 200,
          body: "Webhook upsell reçu"
        };
      }

      const formUrl = `${appBaseUrl}/upsell.html?session_id=${session.id}`;

      const htmlClient = `
        <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;color:#111;">
          <h2 style="margin-bottom:20px;">Paiement confirmé ✅</h2>

          <p>Bonjour ${safeNom},</p>

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

          <div style="background:#f6f8fb;padding:18px;border-radius:12px;margin:20px 0;">
            <h3 style="margin-top:0;">Récapitulatif du paiement</h3>
            <p><strong>Montant payé :</strong> ${safeMontant}</p>
            <p><strong>Service :</strong> ${safeService}</p>
          </div>

          <div style="background:#e8f4ff;padding:12px;border-radius:8px;margin:20px 0;">
            💡 <strong>Astuce :</strong> plus votre demande sera détaillée dans le formulaire suivant,
            plus votre diagnostic sera précis et fiable.
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

            <div style="background:#0f172a;color:#fff;padding:16px 20px;border-radius:16px 16px 0 0;">
              <div style="font-size:12px;font-weight:800;letter-spacing:1px;text-transform:uppercase;">
                PAIEMENT REÇU
              </div>
              <div style="font-size:30px;font-weight:800;line-height:1.15;margin-top:6px;">
                💳 Nouveau paiement diagnostic
              </div>
            </div>

            <div style="background:#ffffff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 16px 16px;padding:22px;">

              <div style="background:${prioriteStyle.bg};border-left:7px solid ${prioriteStyle.border};padding:18px;border-radius:12px;margin-bottom:18px;">
                <div style="font-size:12px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:${prioriteStyle.text};">
                  PRIORITÉ ESTIMÉE
                </div>
                <div style="font-size:22px;font-weight:800;color:${prioriteStyle.text};margin-top:6px;">
                  ${safePriorite}
                </div>
              </div>

              <div style="background:#111827;color:#fff;padding:14px;border-radius:10px;margin-bottom:18px;text-align:center;font-weight:800;">
                Le paiement est confirmé. La demande complète arrivera après le formulaire client.
              </div>

              <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin-bottom:18px;">
                <div style="font-size:16px;font-weight:800;margin-bottom:14px;color:#111827;">
                  Coordonnées connues au moment du paiement
                </div>
                <p style="margin:8px 0;"><strong>Nom :</strong> ${safeNom}</p>
                <p style="margin:8px 0;"><strong>Email :</strong> <a href="mailto:${email}" style="color:#0d6efd;text-decoration:none;">${safeEmail}</a></p>
                <p style="margin:8px 0;"><strong>Téléphone :</strong> ${safeTelephone}</p>
                <p style="margin:8px 0;"><strong>Ville :</strong> ${safeVille}</p>
                <p style="margin:8px 0;"><strong>Logement :</strong> ${safeLogement}</p>
              </div>

              <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin-bottom:18px;">
                <div style="font-size:16px;font-weight:800;margin-bottom:14px;color:#111827;">
                  Paiement
                </div>
                <p style="margin:8px 0;"><strong>Service :</strong> ${safeService}</p>
                <p style="margin:8px 0;"><strong>Montant payé :</strong> ${safeMontant}</p>
                <p style="margin:8px 0;"><strong>Type :</strong> ${safeType}</p>
              </div>

              <div style="background:#fff7ed;border:1px solid #fdba74;border-radius:12px;padding:18px;margin-bottom:18px;">
                <div style="font-size:16px;font-weight:800;margin-bottom:14px;color:#9a3412;">
                  Informations encore provisoires
                </div>
                <p style="margin:8px 0;"><strong>Urgence :</strong> ${safeUrgence}</p>
                <p style="margin:8px 0;"><strong>Problème :</strong><br>${safeProbleme}</p>
              </div>

              <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin-bottom:22px;">
                <div style="font-size:16px;font-weight:800;margin-bottom:14px;color:#111827;">
                  Référence
                </div>
                <p style="margin:8px 0;"><strong>Session Stripe :</strong> ${safeSessionId}</p>
              </div>

              <div style="text-align:center;margin-top:28px;">
                <a href="${formUrl}"
                   style="background:#0d6efd;color:#fff;padding:14px 24px;border-radius:12px;text-decoration:none;font-weight:800;display:inline-block;">
                   👉 Ouvrir le formulaire client
                </a>
              </div>
            </div>
          </div>
        </div>
      `;

      await resend.emails.send({
        from: fromEmail,
        to: customerEmail,
        subject: "Paiement confirmé - Diag Plomberie France",
        html: htmlClient
      });

      await resend.emails.send({
        from: fromEmail,
        to: adminRecipients,
        subject: `💳 PAIEMENT REÇU - ${nom} - ${montant}`,
        html: htmlAdmin,
        replyTo: customerEmail
      });
    }

    return {
      statusCode: 200,
      body: "Webhook reçu"
    };
  } catch (err) {
    console.error("Erreur webhook :", err);
    return {
      statusCode: 500,
      body: "Erreur serveur"
    };
  }
};
