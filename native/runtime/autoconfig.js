pref("general.config.filename", "still.cfg");
pref("general.config.obscure_value", 0);
// Only Still's bundled browser chrome loader runs outside AutoConfig's sandbox.
// Web content keeps Gecko's normal process sandbox and origin isolation.
pref("general.config.sandbox_enabled", false);
