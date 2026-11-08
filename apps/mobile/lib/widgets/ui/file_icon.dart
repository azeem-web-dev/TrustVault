import 'package:flutter/material.dart';

import '../phosphor.dart';

import 'basics.dart';

/* --------------------------------------------------------------- file icon */

class FileKind {
  const FileKind(this.label, this.icon, this.colors);
  final String label;
  final PI icon;
  final List<Color> colors;
}

FileKind fileType(String? fileName) {
  final ext = (fileName ?? '').contains('.') ? fileName!.split('.').last.toLowerCase() : '';
  switch (ext) {
    case 'pdf':
      return FileKind('PDF', PhosphorIconsDuotone.filePdf, const [Color(0xFFF43F5E), Color(0xFFDC2626)]);
    case 'doc':
    case 'docx':
      return FileKind('Word', PhosphorIconsDuotone.fileDoc, const [Color(0xFF0EA5E9), Color(0xFF2563EB)]);
    case 'xls':
    case 'xlsx':
      return FileKind('Excel', PhosphorIconsDuotone.fileXls, const [Color(0xFF10B981), Color(0xFF16A34A)]);
    case 'ppt':
    case 'pptx':
      return FileKind('PowerPoint', PhosphorIconsDuotone.filePpt, const [Color(0xFFFB923C), Color(0xFFEA580C)]);
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
      return FileKind('Image', PhosphorIconsDuotone.fileImage, const [Color(0xFFD946EF), Color(0xFF7C3AED)]);
    case 'csv':
      return FileKind('CSV', PhosphorIconsDuotone.fileCsv, const [Color(0xFF14B8A6), Color(0xFF0891B2)]);
    case 'md':
      return FileKind('Markdown', PhosphorIconsDuotone.fileMd, const [Color(0xFF64748B), Color(0xFF334155)]);
    case 'txt':
      return FileKind('Text', PhosphorIconsDuotone.fileTxt, const [Color(0xFF94A3B8), Color(0xFF475569)]);
    default:
      return FileKind(ext.isEmpty ? 'File' : ext.toUpperCase(), PhosphorIconsDuotone.file, const [Color(0xFF94A3B8), Color(0xFF475569)]);
  }
}

class FileIcon extends StatelessWidget {
  const FileIcon(this.fileName, {super.key, this.size = 40});
  final String? fileName;
  final double size;
  @override
  Widget build(BuildContext context) {
    final k = fileType(fileName);
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(size * 0.28),
        gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: k.colors),
        border: Border.all(color: Colors.white.withValues(alpha: .2)),
        boxShadow: [BoxShadow(color: k.colors.last.withValues(alpha: .25), blurRadius: 8, offset: const Offset(0, 3), spreadRadius: -2)],
      ),
      child: Center(
        child: Ic(k.icon, size: size * 0.5, color: Colors.white),
      ),
    );
  }
}
