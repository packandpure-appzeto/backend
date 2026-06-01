/** Order line-item variant resolution and API enrichment. */

export const ORDER_ITEM_PRODUCT_POPULATE =
  "name mainImage price salePrice variants unit purchasePrice gstRate";

export function findOrderVariant(productDoc, variantId) {
  if (!variantId) return null;
  const list = productDoc?.variants;
  if (!Array.isArray(list) || list.length === 0) return null;
  return (
    list.find((v) => String(v?._id) === String(variantId)) ||
    list.find((v) => String(v?.id) === String(variantId)) ||
    null
  );
}

export function formatOrderVariantSlot(variant, productDoc) {
  if (!variant) return undefined;
  const parts = [variant.name, variant.unit || productDoc?.unit].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

export function resolveOrderItemVariantLabel(item) {
  if (item?.variantSlot) return item.variantSlot;
  const product =
    item?.product && typeof item.product === "object" ? item.product : null;
  const variantId = item?.variantId ? String(item.variantId) : "";
  if (!variantId || !product) return null;
  const variant = findOrderVariant(product, variantId);
  return formatOrderVariantSlot(variant, product) || null;
}

export function resolveOrderItemPrice(productDoc, variant, fallbackPrice) {
  if (variant) {
    return Number(variant.salePrice ?? variant.price) || fallbackPrice || 0;
  }
  return (
    fallbackPrice ||
    Number(productDoc?.salePrice ?? productDoc?.price) ||
    0
  );
}

export function enrichOrderItem(item) {
  if (!item || typeof item !== "object") return item;
  const label = resolveOrderItemVariantLabel(item);
  if (!label || item.variantSlot === label) {
    return label ? { ...item, variantSlot: label } : item;
  }
  return { ...item, variantSlot: label };
}

export function enrichOrderItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map(enrichOrderItem);
}

export function enrichOrderDoc(order) {
  if (!order || typeof order !== "object") return order;
  if (!Array.isArray(order.items)) return order;
  return { ...order, items: enrichOrderItems(order.items) };
}
