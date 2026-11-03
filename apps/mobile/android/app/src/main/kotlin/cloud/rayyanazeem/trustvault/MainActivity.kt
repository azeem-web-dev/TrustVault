package cloud.rayyanazeem.trustvault

import android.view.WindowManager
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

// FragmentActivity: the biometric prompt (local_auth, app lock) and Android's
// Credential Manager (passkeys) both need one.
class MainActivity : FlutterFragmentActivity() {
    // FLAG_SECURE while a document is open (lib/core/secure_screen.dart, THREATS.md V3).
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "trustvault/secure_screen").setMethodCallHandler { call, result ->
            when (call.method) {
                "on" -> { window.addFlags(WindowManager.LayoutParams.FLAG_SECURE); result.success(null) }
                "off" -> { window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE); result.success(null) }
                // For the on-device test (integration_test/pending_features_test.dart).
                "isSecure" -> result.success((window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE) != 0)
                else -> result.notImplemented()
            }
        }
    }
}
