import 'dart:io';

import 'package:flutter/material.dart';
import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';

import '../core/api.dart';
import '../core/theme.dart';
import 'ui.dart';

/// Downloads through the API (so the read is audited exactly like the web),
/// saves into the app's private storage and opens it with the system viewer.
Future<void> downloadAndOpen(BuildContext context, String apiPath, {String fallbackName = 'document'}) async {
  toast(context, 'Downloading…', tone: Tone.blue);
  try {
    final d = await Api.I.download(apiPath, fallbackName: fallbackName);
    final dir = Directory('${(await getApplicationDocumentsDirectory()).path}/downloads');
    await dir.create(recursive: true);
    final safe = d.fileName.replaceAll(RegExp(r'[\\/:*?"<>|]'), '_');
    final file = File('${dir.path}/$safe');
    await file.writeAsBytes(d.bytes, flush: true);
    if (!context.mounted) return;
    final r = await OpenFilex.open(file.path);
    if (!context.mounted) return;
    if (r.type == ResultType.done) {
      toast(context, 'Opened $safe');
    } else if (r.type == ResultType.noAppToOpen) {
      toast(context, 'Saved $safe. No app on this phone opens this file type.', tone: Tone.amber);
    } else {
      toast(context, 'Saved $safe', tone: Tone.blue);
    }
  } catch (e) {
    if (context.mounted) toast(context, errorText(e, 'Download failed'), tone: Tone.red);
  }
}
