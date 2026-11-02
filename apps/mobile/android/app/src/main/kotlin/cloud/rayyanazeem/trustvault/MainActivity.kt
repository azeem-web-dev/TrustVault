package cloud.rayyanazeem.trustvault

import android.view.WindowManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    // FLAG_SECURE while a document is open (lib/core/secure_screen.dart, THREATS.md V3).
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "trustvault/secure_screen").setMethodCallHandler { call, result ->
            when (call.method) {
                "on" -> { window.addFlags(WindowManager.LayoutParams.FLAG_SECURE); result.success(null) }
                "off" -> { window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE); result.success(null) }
                else -> result.notImplemented()
            }
        }
    }
}
