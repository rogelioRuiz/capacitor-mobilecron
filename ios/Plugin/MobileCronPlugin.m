#import <Capacitor/Capacitor.h>

CAP_PLUGIN(MobileCronPlugin, "MobileCron",
           CAP_PLUGIN_METHOD(register, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(unregister, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(update, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(list, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(triggerNow, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(pauseAll, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(resumeAll, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(setMode, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(getStatus, CAPPluginReturnPromise);
)
