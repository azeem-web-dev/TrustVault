import 'package:flutter/material.dart';
import 'package:open_filex/open_filex.dart';

import '../core/api.dart';
import '../core/local_copies.dart';
import '../core/theme.dart';
import 'ui.dart';

/// Test seam: how a saved copy is handed to the system viewer. Tests replace
/// it so no real viewer app is launched.
@visibleForTesting
Future<OpenResult> Function(String path) openFileWith = OpenFilex.open;

/// Downloads through the API (so the read is audited exactly like the web),
/// saves into the app's private storage and opens it with the system viewer.
Future<void> downloadAndOpen(BuildContext context, String apiPath, {String fallbackName = 'document'}) async {
  toast(context, 'Downloading…', tone: Tone.blue);
  try {
    final d = await Api.I.download(apiPath, fallbackName: fallbackName);
    final file = await LocalCopies.save(apiPath, d.fileName, d.bytes);
    final safe = LocalCopies.safeName(d.fileName);
    if (!context.mounted) return;
    final r = await openFileWith(file.path);
    if (!context.mounted) return;
    if (r.type == ResultType.done) {
      toast(context, 'Opened $safe');
    } else if (r.type == ResultType.noAppToOpen) {
      toast(context, 'Saved $safe. No app on this phone opens this file type.', tone: Tone.amber);
    } else {
      toast(context, 'Saved $safe', tone: Tone.blue);
    }
  } catch (e) {
    // No longer ours (revoked, expired, deleted): drop any copy saved earlier.
    if (e is ApiError && e.status == 404) {
      final folder = LocalCopies.folderFor(apiPath);
      if (folder != '_other') await LocalCopies.removeFor(folder);
    }
    if (context.mounted) toast(context, errorText(e, 'Download failed'), tone: Tone.red);
  }
}
