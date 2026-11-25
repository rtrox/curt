# Build context is cli/.
FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
ARG TARGETOS TARGETARCH VERSION=dev
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o /curt .

FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=build /curt /curt
USER 65532:65532
ENTRYPOINT ["/curt"]
