import test from "node:test";
import assert from "node:assert/strict";
import {
  newOverlayField,
  newPage,
  newRecipient,
  standardQuoteTemplate,
} from "../src/lib/doceditor/factory";
import {
  hasSendReadyRecipients,
  looksLikeEmail,
  recipientIdsWithFields,
  remapTemplateSigningRecipients,
} from "../src/lib/signing/templateRecipients";

test("viewer-only and placeholder recipients are not send-ready", () => {
  const viewerOnly = standardQuoteTemplate();
  viewerOnly.recipients = [
    newRecipient({
      id: "viewer",
      name: "Observer",
      email: "observer@example.com",
      role: "viewer",
    }),
  ];
  assert.equal(hasSendReadyRecipients(viewerOnly), false);

  const placeholder = standardQuoteTemplate();
  placeholder.recipients = [
    newRecipient({
      id: "customer-placeholder",
      name: "Customer",
      email: "",
      role: "signer",
    }),
  ];
  assert.equal(hasSendReadyRecipients(placeholder), false);
  assert.equal(looksLikeEmail("customer@example.com"), true);
  assert.equal(looksLikeEmail("not-an-email"), false);
});

test("valid explicit signing recipients are send-ready", () => {
  const doc = standardQuoteTemplate();
  doc.recipients = [
    newRecipient({
      id: "buyer",
      name: "Buyer",
      email: "buyer@example.com",
      role: "signer",
    }),
    newRecipient({
      id: "observer",
      name: "Observer",
      email: "observer@example.com",
      role: "viewer",
    }),
  ];
  assert.equal(hasSendReadyRecipients(doc), true);
});

test("a generic placeholder field is preserved and remapped to the customer", () => {
  const doc = standardQuoteTemplate();
  const placeholder = newRecipient({
    id: "placeholder",
    name: "Customer",
    email: "",
    role: "signer",
  });
  const viewer = newRecipient({
    id: "viewer",
    name: "Observer",
    email: "observer@example.com",
    role: "viewer",
  });
  doc.recipients = [placeholder, viewer];
  doc.pages[0].overlayFields.push(
    newOverlayField("signature", {
      id: "placed-signature",
      recipientId: placeholder.id,
      anchor: {
        mode: "page",
        blockId: null,
        x: 321,
        y: 876,
      },
    }),
  );

  const dealer = newRecipient({
    id: "dealer",
    name: "Denago Rep",
    email: "rep@example.com",
    role: "signer",
  });
  const customer = newRecipient({
    id: "customer",
    name: "Actual Customer",
    email: "customer@example.com",
    role: "signer",
  });

  remapTemplateSigningRecipients(doc, [dealer, customer]);

  const field = doc.pages[0].overlayFields.find(
    (item) => item.id === "placed-signature",
  );
  assert.equal(field?.recipientId, customer.id);
  assert.equal(field?.anchor.x, 321);
  assert.equal(field?.anchor.y, 876);
  assert.deepEqual(
    doc.recipients.map((recipient) => recipient.id),
    [dealer.id, customer.id, viewer.id],
  );
  assert.deepEqual([...recipientIdsWithFields(doc)], [customer.id]);
});

test("dealer and customer fields map by role hints", () => {
  const doc = standardQuoteTemplate();
  doc.pages = [newPage()];
  const oldDealer = newRecipient({
    id: "old-dealer",
    name: "Dealer representative",
    email: "",
  });
  const oldCustomer = newRecipient({
    id: "old-customer",
    name: "Buyer",
    email: "",
  });
  doc.recipients = [oldCustomer, oldDealer];
  doc.pages[0].overlayFields = [
    newOverlayField("signature", {
      id: "customer-field",
      recipientId: oldCustomer.id,
    }),
    newOverlayField("signature", {
      id: "dealer-field",
      recipientId: oldDealer.id,
    }),
  ];

  const dealer = newRecipient({ id: "dealer", email: "rep@example.com" });
  const customer = newRecipient({
    id: "customer",
    email: "customer@example.com",
  });
  remapTemplateSigningRecipients(doc, [dealer, customer]);

  assert.equal(doc.pages[0].overlayFields[0].recipientId, customer.id);
  assert.equal(doc.pages[0].overlayFields[1].recipientId, dealer.id);
});
