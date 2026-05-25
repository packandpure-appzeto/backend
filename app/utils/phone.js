/**
 * Normalize Indian mobile numbers to 10 digits (no +91 prefix in DB).
 */
export const normalizePhone = (raw) => {
    if (raw == null) return "";
    let digits = String(raw).replace(/\D/g, "");
    if (digits.length === 12 && digits.startsWith("91")) {
        digits = digits.slice(2);
    }
    if (digits.length === 11 && digits.startsWith("0")) {
        digits = digits.slice(1);
    }
    return digits;
};

export const isValidIndianPhone = (phone) => /^[6-9]\d{9}$/.test(phone);
