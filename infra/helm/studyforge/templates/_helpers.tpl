{{/*
Helpers — names, labels, image refs.
*/}}

{{- define "studyforge.fullname" -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "studyforge.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "studyforge.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
imageRef takes a sub-key ("web", "api", "aiWorker"), resolves
.Values.image.<key> and emits a digest-pinned image string. Failing to set the
digest in non-dev environments is a hard error.
*/}}
{{- define "studyforge.imageRef" -}}
{{- $svc := index .Values.image .key -}}
{{- $registry := .Values.image.registry -}}
{{- $repo := .Values.image.repository -}}
{{- if and (ne .Values.env.NODE_ENV "development") (not $svc.digest) -}}
{{- fail (printf "image.%s.digest must be set for non-dev environments" .key) -}}
{{- end -}}
{{- if $svc.digest -}}
{{ printf "%s/%s/%s@%s" $registry $repo $svc.name $svc.digest }}
{{- else -}}
{{ printf "%s/%s/%s:latest" $registry $repo $svc.name }}
{{- end -}}
{{- end -}}
