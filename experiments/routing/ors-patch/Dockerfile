FROM openrouteservice/openrouteservice:v10.1.0@sha256:53879ce3ee12102242abf64fc41ca6a5cef3c8d553d16c196cf7b33b7781c4a5 AS patch
USER root
WORKDIR /patch-build
COPY ORSOSMReader.java ./ORSOSMReader.java
RUN jar xf /ors.jar BOOT-INF/lib && \
    javac -cp 'BOOT-INF/lib/*' -d classes ORSOSMReader.java && \
    jar uf BOOT-INF/lib/ors-engine-10.1.0.jar -C classes . && \
    jar u0f /ors.jar BOOT-INF/lib/ors-engine-10.1.0.jar

FROM openrouteservice/openrouteservice:v10.1.0@sha256:53879ce3ee12102242abf64fc41ca6a5cef3c8d553d16c196cf7b33b7781c4a5
COPY --from=patch /ors.jar /ors.jar
LABEL org.richiroute.ors.patch="missing-endpoint-v1"
