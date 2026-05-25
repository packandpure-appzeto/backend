import Setting from "../models/setting.js";

export const SUSPENDED_MESSAGE =
    "Your account is currently suspended. Please contact the administrator.";

export const getPlatformSupportContact = async () => {
    const settings = await Setting.findOne({
        $or: [{ tenantId: null }, { tenantId: { $exists: false } }],
    })
        .select("supportEmail supportPhone")
        .lean();

    return {
        supportEmail:
            settings?.supportEmail?.trim() ||
            process.env.SUPPORT_EMAIL ||
            "support@packandpure.com",
        supportPhone: settings?.supportPhone?.trim() || "",
    };
};
